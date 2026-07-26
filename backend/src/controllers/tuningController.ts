import {spawn} from "bun";
import path from "node:path";
import {mkdir, writeFile} from "node:fs/promises";
import {
    sshTargetFromEnv,
    sshArgs,
    defaultRemoteConfig,
    absolutizeConfig,
    remoteEnginePath,
    type SshTarget,
    type RemoteConfig,
} from "./selfPlayController.ts";

// Server-driven eval tuning. Mirrors the self-play model: the heavy work runs on
// the remote host over SSH. This controller:
//   1. builds a Texel dataset (EPD) from games already in the database,
//   2. ships it to the remote and runs `jewkiebot tune` there, streaming epochs,
//   3. pulls the optimized parameter vector back, persists it, and live-applies
//      it to the managed engine (via the same EvalParamsFile path the engine
//      loads on spawn).
// A single run is active at a time; progress is polled via status().

interface TuningState {
    taskId: string | null;
    running: boolean;
    phase: string;            // building | shipping | tuning | applying | done | failed | stopped
    epoch: number;
    mse: number | null;
    positions: number;
    maxEpochs: number;
    appliedCount: number | null;
    error: string | null;
    startedAt: number;
    // internal (not serialized):
    proc?: any;
    remoteOut?: string;
    stopRequested?: boolean;
}

function idleState(): TuningState {
    return {
        taskId: null, running: false, phase: "idle", epoch: 0, mse: null,
        positions: 0, maxEpochs: 0, appliedCount: null, error: null, startedAt: 0,
    };
}

export class TuningController {
    private state: TuningState = idleState();
    private cfg: RemoteConfig;
    private _cfgResolved = false;
    private spawnFn: any;

    constructor(
        private taskManager: any,
        private dbClient: any,
        private engineManager: any,
        private evalParamsPath: string,
        options: {spawn?: any; config?: RemoteConfig} = {},
    ) {
        this.spawnFn = options.spawn ?? spawn;
        this.cfg = options.config ?? defaultRemoteConfig();
    }

    // GET /api/engine/tuning/status — current run progress (or the last result).
    status = async (req: any, res: any): Promise<any> => {
        const {proc, ...pub} = this.state;
        res.json(pub);
    }

    // POST /api/engine/tuning/run { games?, maxEpochs? } — start a tuning run.
    run = async (req: any, res: any): Promise<any> => {
        if (this.state.running) {
            return res.status(409).json({error: "A tuning run is already active"});
        }
        const target = sshTargetFromEnv();
        if (!target) {
            return res.status(503).json({error: "Remote execution not configured (set REMOTE_ENGINE_ENABLED=true and REMOTE_SSH_*). Tuning runs on the remote host."});
        }

        const games = Math.max(1, parseInt(String(req.body?.games ?? 200), 10));
        const maxEpochs = Math.max(1, parseInt(String(req.body?.maxEpochs ?? 50), 10));
        const taskId = `tune-${Date.now()}`;

        this.state = {
            ...idleState(),
            taskId, running: true, phase: "building", maxEpochs, startedAt: Date.now(),
        };

        await this.taskManager.createTask(taskId, "tuning", {games, maxEpochs}).catch(() => {});
        res.json({status: "started", taskId});

        this._execute(target, games, maxEpochs).catch(async (err: any) => {
            this.state.running = false;
            this.state.phase = "failed";
            this.state.error = err.message;
            await this.taskManager.updateTaskStatus(taskId, "FAILED", {error: err.message}).catch(() => {});
        });
    }

    // POST /api/engine/tuning/stop — cancel the active run.
    stopRun = async (req: any, res: any): Promise<any> => {
        if (!this.state.running) return res.status(409).json({error: "No active tuning run"});
        this.state.stopRequested = true;

        const target = sshTargetFromEnv();
        if (target && this.state.remoteOut) {
            // Kill the remote tuner, targeted by its unique output path.
            this._ssh(target, `pkill -f ${JSON.stringify(this.state.remoteOut)}`).catch(() => {});
        }
        try { this.state.proc?.kill(); } catch (_) {}

        res.json({status: "stopping"});
    }

    private async _execute(target: SshTarget, games: number, maxEpochs: number) {
        if (!this._cfgResolved) {
            this.cfg = await absolutizeConfig(target, this.cfg, this.spawnFn);
            this._cfgResolved = true;
        }

        // 1. Build the EPD dataset from recent DB games.
        this.state.phase = "building";
        const recent = await this.dbClient.getRecentGames(games).catch(() => []);
        const list = TuningController.asArray(recent);
        if (list.length === 0) throw new Error("No games in the database to build a tuning dataset");

        const {lines, positions, stats} = await this._buildEpd(list);
        if (!positions) {
            // Report the breakdown so the cause is obvious (no decisive results?
            // no ingested moves? everything filtered as opening/in-check?).
            throw new Error(
                `Dataset is empty — ${stats.games} games, ${stats.decisive} decisive, ` +
                `${stats.withMoves} with ingested moves, ${stats.candidates} candidate positions. ` +
                `Tuning needs decisive games whose moves are stored in the database.`,
            );
        }
        this.state.positions = positions;
        const epdText = lines.join("\n") + "\n";

        // 2. Ship the dataset to the remote.
        this.state.phase = "shipping";
        const remoteDir = `${this.cfg.repoDir}/backend/storage`;
        const remoteEpd = `${remoteDir}/tuning_${this.state.taskId}.epd`;
        const remoteOut = `${remoteDir}/tuning_${this.state.taskId}.params`;
        this.state.remoteOut = remoteOut;
        await this._sshWithInput(target, `mkdir -p ${JSON.stringify(remoteDir)} && cat > ${JSON.stringify(remoteEpd)}`, epdText);

        // 3. Run the tuner on the remote's current engine build, streaming epochs.
        this.state.phase = "tuning";
        const enginePath = remoteEnginePath("current", this.cfg);
        const cmd = `printf 'tune %s %s %d\\nquit\\n' ${JSON.stringify(remoteEpd)} ${JSON.stringify(remoteOut)} ${maxEpochs} | ${JSON.stringify(enginePath)}`;
        const proc = this.spawnFn({cmd: sshArgs(target, cmd), stdout: "pipe", stderr: "pipe"});
        this.state.proc = proc;

        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout) {
            buf += dec.decode(chunk);
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                const m = line.match(/^tune epoch (\d+) mse ([\d.]+)/);
                if (m) {
                    this.state.epoch = parseInt(m[1], 10);
                    this.state.mse = parseFloat(m[2]);
                    await this.taskManager.updateTaskProgress(this.state.taskId, {
                        epoch: this.state.epoch, mse: this.state.mse, positions: this.state.positions,
                    }).catch(() => {});
                }
            }
        }
        const code = await proc.exited;

        if (this.state.stopRequested) {
            this.state.running = false;
            this.state.phase = "stopped";
            await this.taskManager.updateTaskStatus(this.state.taskId, "FAILED", {stopped: true}).catch(() => {});
            return;
        }
        if (code !== 0) {
            const stderr = await new Response(proc.stderr).text().catch(() => "");
            throw new Error(`tuner exited ${code}: ${stderr.trim().slice(0, 300)}`);
        }

        // 4. Pull the optimized params, persist, and live-apply.
        this.state.phase = "applying";
        const {stdout} = await this._ssh(target, `cat ${JSON.stringify(remoteOut)}`);
        const params = stdout.split(/\s+/).filter(Boolean).map(Number);
        if (params.length === 0 || params.some((n) => !Number.isFinite(n))) {
            throw new Error("Tuner produced no valid parameters");
        }

        await mkdir(path.dirname(this.evalParamsPath), {recursive: true});
        await writeFile(this.evalParamsPath, params.map((n) => Math.round(n)).join("\n") + "\n");

        try {
            const main = this.engineManager.getEngine("Main");
            if (main && typeof main.setOption === "function") {
                await main.setOption("EvalParamsFile", this.evalParamsPath);
            }
        } catch (_) { /* live-apply is best-effort; it loads on next spawn regardless */ }

        this.state.appliedCount = params.length;
        this.state.phase = "done";
        this.state.running = false;
        await this.taskManager.updateTaskStatus(this.state.taskId, "COMPLETED", {
            positions: this.state.positions, epochs: this.state.epoch, mse: this.state.mse, params: params.length,
        }).catch(() => {});
    }

    // How many opening plies to drop before sampling positions (mirrors the
    // original parsePgnToEpd behaviour: skip the first 12 half-moves).
    private static readonly OPENING_PLIES = 12;

    // Map a PGN/DB result string to a Texel label, or null if not decisive/known.
    private static resultLabel(result: any): string | null {
        if (result === "1-0" || result === "1.0" || result === 1) return "1.0";
        if (result === "0-1" || result === "0.0" || result === 0) return "0.0";
        if (result === "1/2-1/2" || result === "0.5" || result === 0.5) return "0.5";
        return null;
    }

    // Normalize an API list response to an array, tolerating a `{data:[...]}`
    // wrapper (Laravel resource collections) even if the transport already unwraps.
    private static asArray(v: any): any[] {
        if (Array.isArray(v)) return v;
        if (Array.isArray(v?.data)) return v.data;
        if (Array.isArray(v?.moves)) return v.moves;
        return [];
    }

    // Build Texel EPD lines directly from stored move FENs. Each move row carries
    // `fen_after` (the position after that ply), so no PGN round-trip or replay is
    // needed — which also means book-opening starts are handled correctly. Skips
    // the opening and in-check positions, and reports a breakdown so an empty
    // result is diagnosable (decisive games? games with moves? candidate plies?).
    private async _buildEpd(games: any[]): Promise<{
        lines: string[];
        positions: number;
        stats: {games: number; decisive: number; withMoves: number; candidates: number};
    }> {
        const {Chess} = await import("chess.js");
        const lines: string[] = [];
        let decisive = 0, withMoves = 0, candidates = 0;

        for (const game of games) {
            const label = TuningController.resultLabel(game?.result);
            if (label === null) continue;  // skip unfinished / unknown-result games
            decisive++;

            const moves = TuningController.asArray(await this.dbClient.getGameMoves(game.id).catch(() => []));
            if (moves.length === 0) continue;
            withMoves++;

            for (const mv of moves) {
                const fen = mv?.fen_after ?? mv?.fenAfter;
                const ply = Number(mv?.ply);
                if (!fen || !Number.isFinite(ply) || ply <= TuningController.OPENING_PLIES) continue;
                candidates++;
                let inCheck = false;
                try { inCheck = new Chess(fen).inCheck(); } catch (_) { /* keep on parse failure */ }
                if (!inCheck) lines.push(`${fen} c9 "${label}"`);
            }
        }
        return {lines, positions: lines.length, stats: {games: games.length, decisive, withMoves, candidates}};
    }

    private async _ssh(target: SshTarget, remoteCommand: string): Promise<{code: number; stdout: string; stderr: string}> {
        const proc = this.spawnFn({cmd: sshArgs(target, remoteCommand), stdout: "pipe", stderr: "pipe"});
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return {code, stdout, stderr};
    }

    private async _sshWithInput(target: SshTarget, remoteCommand: string, input: string): Promise<void> {
        const proc = this.spawnFn({cmd: sshArgs(target, remoteCommand), stdin: "pipe", stdout: "pipe", stderr: "pipe"});
        proc.stdin.write(input);
        await proc.stdin.end();
        const code = await proc.exited;
        if (code !== 0) {
            const stderr = await new Response(proc.stderr).text().catch(() => "");
            throw new Error(`failed to upload dataset (${code}): ${stderr.trim().slice(0, 200)}`);
        }
    }
}
