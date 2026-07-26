import {spawn} from "bun";
import {EventEmitter} from "node:events";
import {mkdir, writeFile, readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";

// Self-play, fully remote. Per the deployment model, engine matches must run on
// the remote Linux host over SSH — never on the home server. This controller:
//   1. lists release tags (built on demand) plus the live "current" build,
//   2. compiles a requested tag from source on the remote (cached),
//   3. runs cutechess-cli on the remote and tails its PGN so finished games
//      stream back live over SSE,
//   4. ingests the games and can kick off Stockfish+jewkiebot analysis.
// The pure command-builders and parsers are exported for unit testing without
// touching SSH.

export interface SshTarget {
    host: string;
    user?: string;
    keyPath?: string;
}

export interface RemoteConfig {
    repoDir: string;       // remote checkout of this repo
    cutechess: string;     // cutechess-cli on the remote (PATH by default)
    openingBook: string | null;
}

export interface SelfPlayRequest {
    v1: string;            // release tag (e.g. "v2.1.0") or "current"
    v2: string;
    games: number;
    tc?: string;           // cutechess time control, e.g. "10+0.1"
    depth?: number | null;
    nodes?: number | null;
    concurrency?: number;
    pgnOut: string;        // absolute remote path for the match PGN
}

export interface SelfPlayVersion {
    version: string;
    label: string;
    isCurrent: boolean;
}

export function defaultRemoteConfig(env = process.env): RemoteConfig {
    const repoDir = env.REMOTE_REPO_DIR ?? "$HOME/dss/apps/jewkiebot";
    return {
        repoDir,
        cutechess: env.REMOTE_CUTECHESS ?? "cutechess-cli",
        openingBook: env.REMOTE_OPENING_BOOK ?? `${repoDir}/tools/UHO_4060_v1.epd`,
    };
}

// Paths may use `~` or `$HOME` (docker env files don't expand them, and once a
// path is quoted into an SSH command the remote shell won't either). Substitute
// a known absolute home so cutechess receives real paths.
export function substituteHome(p: string | null, home: string): string | null {
    if (!p || !home) return p;
    if (p === "~") return home;
    if (p.startsWith("~/")) return home + p.slice(1);
    return p.replace(/\$\{HOME\}|\$HOME/g, home);
}

function pathNeedsHome(p: string | null): boolean {
    return !!p && (p.startsWith("~") || p.includes("$HOME"));
}

// Resolve `~`/`$HOME` in a RemoteConfig against the remote account's actual home
// (queried once over SSH). No-op when the paths are already absolute.
export async function absolutizeConfig(target: SshTarget, cfg: RemoteConfig, spawnFn: any = spawn): Promise<RemoteConfig> {
    if (!pathNeedsHome(cfg.repoDir) && !pathNeedsHome(cfg.openingBook)) return cfg;

    let home = "";
    try {
        const proc = spawnFn({cmd: sshArgs(target, 'printf %s "$HOME"'), stdout: "pipe", stderr: "pipe"});
        home = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
    } catch (_) {
        return cfg; // best effort — fall back to the configured value
    }
    if (!home) return cfg;

    return {
        repoDir: substituteHome(cfg.repoDir, home)!,
        cutechess: cfg.cutechess,
        openingBook: substituteHome(cfg.openingBook, home),
    };
}

// SSH target from the same env the rest of the app uses. null when remote
// execution isn't configured, so the controller can refuse to run locally.
export function sshTargetFromEnv(env = process.env): SshTarget | null {
    if (env.REMOTE_ENGINE_ENABLED !== "true") return null;
    if (!env.REMOTE_SSH_HOST) return null;
    return {
        host: env.REMOTE_SSH_HOST,
        user: env.REMOTE_SSH_USER || undefined,
        keyPath: env.REMOTE_SSH_KEY_PATH || undefined,
    };
}

// argv for `ssh <target> <remoteCommand>`. Mirrors SshUciEngine's flags so SSH
// behaviour (key, host-key policy, keepalive) is identical across the app.
export function sshArgs(target: SshTarget, remoteCommand: string): string[] {
    const args = ["ssh"];
    if (target.keyPath) args.push("-i", target.keyPath);
    args.push("-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30");
    args.push(target.user ? `${target.user}@${target.host}` : target.host);
    args.push(remoteCommand);
    return args;
}

// Versions are spliced into remote shell commands and used as git refs, so
// restrict them to a tag-like charset (or "current"). The leading char must be
// alphanumeric so a value can't be mistaken for a CLI flag, and the absence of
// quotes/whitespace/`$`/`;`/backticks blocks shell-command injection.
export function isValidVersion(version: unknown): version is string {
    return typeof version === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version);
}

// Where a version's engine binary lives on the remote. "current"/empty is the
// live build; a tag is its cached, per-tag binary.
export function remoteEnginePath(version: string, cfg: RemoteConfig): string {
    const buildDir = `${cfg.repoDir}/engines/jewkiebot/build`;
    return !version || version === "current"
        ? `${buildDir}/jewkiebot`
        : `${buildDir}/jewkiebot-${version}`;
}

// One-line shell command that ensures a tag's engine is built and cached on the
// remote (no-op if cached, no build for "current"). Builds the CMake `jewkiebot`
// target and stamps ENGINE_VERSION so the binary self-reports its version.
export function buildVersionScript(version: string, cfg: RemoteConfig): string {
    if (!version || version === "current") return `echo "current build"`;

    const out = remoteEnginePath(version, cfg);
    const tmp = `/tmp/jb-build-${version}`;
    const build = `${tmp}/build`;

    return [
        `if [ -x "${out}" ]; then echo "cached ${version}"; exit 0; fi`,
        `rm -rf "${tmp}"`,
        `mkdir -p "${tmp}"`,
        `git -C "${cfg.repoDir}" fetch origin tag "${version}" --no-tags || true`,
        `if git -C "${cfg.repoDir}" ls-tree -r "${version}" --name-only | grep -q "^engines/jewkiebot/"; then EDIR="engines/jewkiebot"; TARGET="jewkiebot"; else EDIR="engines/myengine"; TARGET="myengine"; fi`,
        `git -C "${cfg.repoDir}" archive "${version}" "$EDIR" | tar -x -C "${tmp}"`,
        `cmake -S "${tmp}/$EDIR" -B "${build}" -DCMAKE_BUILD_TYPE=Release -DENGINE_VERSION="${version}"`,
        `cmake --build "${build}" --target "$TARGET" -j`,
        `cp "${build}/$TARGET" "${out}"`,
        `chmod +x "${out}"`,
        `rm -rf "${tmp}"`,
        `echo "built ${version}"`,
    ].join(" && ");
}

// The remote cutechess-cli invocation. Two games per round (colours swapped),
// like the rest of the codebase, so rounds = ceil(games / 2). Ensures the PGN
// directory exists first.
export function cutechessCommand(req: SelfPlayRequest, cfg: RemoteConfig): string {
    const rounds = Math.max(1, Math.ceil(req.games / 2));
    const concurrency = req.concurrency ?? 2;
    const tc = req.tc ?? "10+0.1";

    const each = [`proto=uci`, `tc=${tc}`];
    if (req.depth) each.push(`depth=${req.depth}`);
    if (req.nodes) each.push(`nodes=${req.nodes}`);

    const cutechess = [
        cfg.cutechess,
        `-engine name="Jewkiebot-${req.v1}" cmd="${remoteEnginePath(req.v1, cfg)}"`,
        `-engine name="Jewkiebot-${req.v2}" cmd="${remoteEnginePath(req.v2, cfg)}"`,
        `-each ${each.join(" ")}`,
        `-games 2 -rounds ${rounds} -repeat`,
        `-concurrency ${concurrency}`,
        `-ratinginterval 10`,
        `-pgnout "${req.pgnOut}"`,
        cfg.openingBook ? `-openings file="${cfg.openingBook}" format=epd order=random plies=16` : "",
    ].filter(Boolean).join(" ");

    return [
        `mkdir -p "$(dirname "${req.pgnOut}")"`,
        `cd "${cfg.repoDir}"`,
        cutechess,
    ].join(" && ");
}

// Split a concatenated PGN blob into COMPLETE games only. A game counts as
// complete once it carries a result token, so a half-flushed game cutechess is
// still writing isn't emitted early.
export function splitCompletedGames(pgnText: string): string[] {
    if (!pgnText) return [];

    const chunks = pgnText
        .replace(/\r\n/g, "\n")
        .split(/\n(?=\[Event )/g)
        .map(s => s.trim())
        .filter(Boolean);

    const RESULT = /(?:^|\s)(1-0|0-1|1\/2-1\/2|\*)\s*$/;
    return chunks.filter(c => RESULT.test(c));
}

// How many games cutechess reports finishing, from its stdout.
export function countFinishedGames(stdout: string): number {
    const matches = stdout.match(/Finished game \d+/g);
    return matches ? matches.length : 0;
}

// Latest "Elo difference: X +/- Y" cutechess prints each rating interval.
export function parseLatestElo(stdout: string): {elo: number; error: number} | null {
    const matches = [...stdout.matchAll(/Elo difference:\s*(-?[\d.]+)\s*\+\/-\s*([\d.]+|nan|inf)/gi)];
    if (matches.length === 0) return null;
    const last = matches[matches.length - 1];
    return {elo: parseFloat(last[1]), error: parseFloat(last[2])};
}

// Parse `git ls-remote --tags` output into selectable versions, with
// "current" prepended.
export function parseGitTags(stdout: string): SelfPlayVersion[] {
    const tags = stdout
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const match = line.match(/refs\/tags\/(v\d+\.\d+(?:\.\d+)?)(?:\^\{\})?$/);
            return match ? match[1] : null;
        })
        .filter((t): t is string => !!t);

    const uniqueTags = [...new Set(tags)].sort((a, b) => {
        const pa = a.substring(1).split('.').map(Number);
        const pb = b.substring(1).split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const numA = pa[i] || 0;
            const numB = pb[i] || 0;
            if (numA !== numB) return numB - numA;
        }
        return 0;
    });

    return [
        {version: "current", label: "Current build", isCurrent: true},
        ...uniqueTags.map(tag => ({version: tag, label: tag, isCurrent: false})),
    ];
}

interface RunState {
    taskId: string;
    status: "running" | "completed" | "failed";
    progress: {completed: number; total: number};
    elo: {elo: number; error: number} | null;
    games: string[];
    emitter: EventEmitter;
    error?: string;
}

// Grace period a finished run lingers in memory so late SSE subscribers can
// still replay its games, before it's evicted to keep the runs map bounded.
const RUN_RETENTION_MS = 5 * 60_000;

// Local dir (inside the backend) where each finished match's full PGN is archived
// by task id, so completed runs stay viewable after the in-memory run state is
// evicted (RUN_RETENTION_MS) or the server restarts.
const LOCAL_STORAGE_DIR = process.env.SELFPLAY_STORAGE_DIR ?? "storage";

// Task ids are minted as `selfplay-<epochMs>` (see run()). Validate before using
// one in a filesystem path so a crafted :taskId can't traverse out of storage.
export function isValidTaskId(id: unknown): id is string {
    return typeof id === "string" && /^selfplay-\d+$/.test(id);
}

export function localPgnPath(taskId: string): string {
    return join(LOCAL_STORAGE_DIR, `selfplay_${taskId}.pgn`);
}

export class SelfPlayController {
    private runs = new Map<string, RunState>();
    private spawnFn: any;
    private cfg: RemoteConfig;
    private _cfgResolved = false;

    constructor(
        private taskManager: any,
        private pgnManager: any,
        private analyzer: {analyzeAll: (p?: string | null) => Promise<void>; isRunning: boolean} | null = null,
        options: {spawn?: any; config?: RemoteConfig} = {},
    ) {
        this.spawnFn = options.spawn ?? spawn;
        this.cfg = options.config ?? defaultRemoteConfig();
    }

    // GET /api/selfplay/versions — release tags (built on demand) + "current".
    versions = async (req: any, res: any): Promise<any> => {
        try {
            const proc = this.spawnFn({cmd: ["git", "ls-remote", "--tags", "origin"], stdout: "pipe", stderr: "pipe"});
            const out = await new Response(proc.stdout).text();
            await proc.exited;
            res.json({versions: parseGitTags(out)});
        } catch (err: any) {
            // git missing or unreachable shouldn't break the page — at least offer "current".
            res.json({versions: [{version: "current", label: "Current build", isCurrent: true}], warning: err.message});
        }
    }

    // POST /api/selfplay/run — start a remote match. Returns a taskId; live games
    // and progress are delivered via GET /api/selfplay/stream/:taskId.
    run = async (req: any, res: any): Promise<any> => {
        const target = sshTargetFromEnv();
        if (!target) {
            return res.status(503).json({error: "Remote execution not configured (set REMOTE_ENGINE_ENABLED=true and REMOTE_SSH_*). Self-play only runs on the remote host."});
        }

        const {v1 = "current", v2 = "current", games = 10, tc, depth, nodes, concurrency, analyze = false} = req.body ?? {};

        // Reject anything that isn't a safe version token before it reaches the
        // remote shell (see isValidVersion). Never run on unvalidated input.
        if (!isValidVersion(v1) || !isValidVersion(v2)) {
            return res.status(400).json({error: "Invalid version. Use 'current' or a release tag (letters, digits, '.', '-', '_' only)."});
        }

        // Resolve ~/$HOME in the configured paths against the remote home (once).
        if (!this._cfgResolved) {
            this.cfg = await absolutizeConfig(target, this.cfg, this.spawnFn);
            this._cfgResolved = true;
        }

        const taskId = `selfplay-${Date.now()}`;
        const pgnOut = `${this.cfg.repoDir}/backend/storage/selfplay_${taskId}.pgn`;

        const state: RunState = {
            taskId,
            status: "running",
            progress: {completed: 0, total: parseInt(String(games), 10)},
            elo: null,
            games: [],
            emitter: new EventEmitter(),
        };
        state.emitter.setMaxListeners(0);
        state.emitter.on("error", () => {});
        this.runs.set(taskId, state);

        try {
            await this.taskManager.createTask(taskId, "selfplay", {v1, v2, games, tc, depth, nodes});
        } catch (_) {
            // Task persistence is best-effort; the live stream still works without it.
        }

        res.json({status: "started", taskId});

        const request: SelfPlayRequest = {
            v1, v2,
            games: parseInt(String(games), 10),
            tc, depth: depth ?? null, nodes: nodes ?? null,
            concurrency: concurrency ? parseInt(String(concurrency), 10) : undefined,
            pgnOut,
        };

        this._execute(state, target, request, {analyze: !!analyze}).catch(async (err: any) => {
            state.status = "failed";
            state.error = err.message;
            state.emitter.emit("error", err.message);
            await this.taskManager.updateTaskStatus(taskId, "FAILED", {error: err.message}).catch(() => {});
        }).finally(() => this._retire(taskId));
    }

    // Drop a finished run from memory after the retention window so the runs map
    // (each entry holds an EventEmitter and every game's PGN) can't grow without
    // bound over the server's lifetime.
    private _retire(taskId: string) {
        const timer = setTimeout(() => this.runs.delete(taskId), RUN_RETENTION_MS);
        timer.unref?.();
    }

    // GET /api/selfplay/stream/:taskId — SSE of live games + progress. Replays
    // what's happened so far, then forwards new events until the run ends.
    stream = async (req: any, res: any): Promise<any> => {
        const state = this.runs.get(req.params.taskId);
        if (!state) return res.status(404).json({error: "Unknown self-play task"});

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const send = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        // Replay current state for late subscribers.
        send("progress", {progress: state.progress, elo: state.elo});
        state.games.forEach((pgn, i) => send("game", {index: i, pgn}));
        if (state.status !== "running") {
            send(state.status === "completed" ? "done" : "error", {status: state.status, error: state.error});
            return res.end();
        }

        const onGame = (payload: any) => send("game", payload);
        const onProgress = (payload: any) => send("progress", payload);
        const onDone = (payload: any) => { send("done", payload); cleanup(); res.end(); };
        const onError = (msg: any) => { send("error", {error: msg}); cleanup(); res.end(); };

        const cleanup = () => {
            state.emitter.off("game", onGame);
            state.emitter.off("progress", onProgress);
            state.emitter.off("done", onDone);
            state.emitter.off("error", onError);
        };

        state.emitter.on("game", onGame);
        state.emitter.on("progress", onProgress);
        state.emitter.on("done", onDone);
        state.emitter.on("error", onError);
        req.on("close", cleanup);
    }

    // GET /api/selfplay/games/:taskId — a run's games for (non-live) replay.
    // Serves the in-memory run if still present, else the archived PGN of a
    // finished run. Always 200 with a `status`/`running` so the UI can render a
    // clean state — a running run tells the client to open the SSE stream, an
    // evicted one shows "unavailable" instead of surfacing a 404 error.
    games = async (req: any, res: any): Promise<any> => {
        const taskId = req.params.taskId;
        if (!isValidTaskId(taskId)) {
            return res.json({status: "unavailable", running: false, games: []});
        }

        const live = this.runs.get(taskId);
        if (live) {
            return res.json({
                status: live.status,
                running: live.status === "running",
                elo: live.elo,
                progress: live.progress,
                games: live.games,
            });
        }

        const path = localPgnPath(taskId);
        if (existsSync(path)) {
            let pgnText = "";
            try { pgnText = await readFile(path, "utf8"); } catch (_) { /* fall through to empty */ }
            const games = splitCompletedGames(pgnText);

            // A PGN file only exists once a match finished, so this is complete.
            // Pull the recorded Elo from the persisted task if it's available.
            let elo = null;
            try {
                const task = await this.taskManager.getTask(taskId);
                if (task?.result?.elo) elo = task.result.elo;
            } catch (_) { /* best-effort */ }

            return res.json({
                status: "completed",
                running: false,
                elo,
                progress: {completed: games.length, total: games.length},
                games,
            });
        }

        return res.json({status: "unavailable", running: false, games: []});
    }

    private async _execute(state: RunState, target: SshTarget, req: SelfPlayRequest, opts: {analyze: boolean}) {
        // 1. Build any requested tags on the remote (cached, no-op for "current").
        for (const version of [req.v1, req.v2]) {
            const script = buildVersionScript(version, this.cfg);
            const {code, stderr} = await this._sshOnce(target, script);
            if (code !== 0) throw new Error(`Build of ${version} failed: ${stderr.trim().slice(0, 300)}`);
        }

        // 2. Tail the PGN so finished games stream back live.
        const tail = this.spawnFn({cmd: sshArgs(target, `tail -n +1 -F "${req.pgnOut}" 2>/dev/null`), stdout: "pipe", stderr: "pipe"});
        let pgnBuffer = "";
        (async () => {
            const dec = new TextDecoder();
            for await (const chunk of tail.stdout) {
                pgnBuffer += dec.decode(chunk);
                const completed = splitCompletedGames(pgnBuffer);
                while (state.games.length < completed.length) {
                    const idx = state.games.length;
                    state.games.push(completed[idx]);
                    state.emitter.emit("game", {index: idx, pgn: completed[idx]});
                }
            }
        })().catch(() => {/* tail stream errors are non-fatal; cat+ingest is the source of truth */});

        // 3. Run cutechess on the remote, parsing stdout for progress + Elo.
        const match = this.spawnFn({cmd: sshArgs(target, cutechessCommand(req, this.cfg)), stdout: "pipe", stderr: "pipe"});
        let matchOut = "";
        (async () => {
            const dec = new TextDecoder();
            for await (const chunk of match.stdout) {
                matchOut += dec.decode(chunk);
                state.progress = {completed: countFinishedGames(matchOut), total: req.games};
                state.elo = parseLatestElo(matchOut) ?? state.elo;
                state.emitter.emit("progress", {progress: state.progress, elo: state.elo});
                await this.taskManager.updateTaskProgress(state.taskId, state.progress).catch(() => {});
            }
        })().catch(() => {/* progress parsing is best-effort; match.exited drives completion */});

        const code = await match.exited;
        try { tail.kill(); } catch (_) {}

        if (code !== 0) {
            const stderr = await new Response(match.stderr).text().catch(() => "");
            throw new Error(`cutechess exited ${code}: ${stderr.trim().slice(0, 300)}`);
        }

        // 4. Pull the final PGN and ingest it into the DB.
        const {stdout: fullPgn} = await this._sshOnce(target, `cat "${req.pgnOut}"`);

        // Archive the full PGN locally, keyed by task id, so this run stays
        // replayable via games() after it's evicted from memory or the server
        // restarts. Best-effort — the DB ingest below is the source of truth.
        try {
            await mkdir(LOCAL_STORAGE_DIR, {recursive: true});
            await writeFile(localPgnPath(state.taskId), fullPgn);
        } catch (_) { /* non-fatal: live stream + DB ingest still work */ }

        const ingest = await this.pgnManager.ingestPgnString(fullPgn);

        state.status = "completed";
        state.emitter.emit("done", {status: "completed", progress: state.progress, elo: state.elo, ingested: ingest?.success});
        await this.taskManager.updateTaskStatus(state.taskId, "COMPLETED", {
            pgnFile: req.pgnOut,
            ingested: ingest?.success,
            elo: state.elo,
        }).catch(() => {});

        // 5. Optionally analyze the new games (Stockfish + jewkiebot) in the
        // background — non-fatal if it can't start.
        if (opts.analyze && this.analyzer && !this.analyzer.isRunning) {
            this.analyzer.analyzeAll(null).catch(() => {});
        }
    }

    // Run a one-shot SSH command, collecting stdout/stderr and the exit code.
    private async _sshOnce(target: SshTarget, remoteCommand: string): Promise<{code: number; stdout: string; stderr: string}> {
        const proc = this.spawnFn({cmd: sshArgs(target, remoteCommand), stdout: "pipe", stderr: "pipe"});
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return {code, stdout, stderr};
    }
}
