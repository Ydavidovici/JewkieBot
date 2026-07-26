import {OPENINGS} from "../openings";
import {EngineManager} from "../engineManager.ts";
import {Notifier} from "../notifier";
import {GameAnalyzer} from "../gameAnalyzer";
import path from "node:path";
import {mkdir, writeFile, unlink} from "node:fs/promises";
import {existsSync} from "node:fs";

export class EngineController {
    constructor(
        private engineManager: EngineManager,
        private notifier: Notifier,
        private mainEnginePath: string,
        private analyzer: GameAnalyzer,
        private taskManager: any,
    ) {}

    getOpenings = async (req: any, res: any): Promise<any> => {
        res.json(OPENINGS);
    }

    setOptions = async (req: any, res: any): Promise<any> => {
        try {
            const {name, value} = req.body ?? {};

            if (!name) {
                return res.status(400).json({error: "Option name required"});
            }

            const mainEngine = this.engineManager.getEngine("Main");
            await mainEngine.setOption(name, value);

            res.json({status: "success"});
        } catch (err) {
            this.notifier.error("SetOption Error:", err);
            res.status(500).json({error: err.message});
        }
    }

    // GET /api/engine/tuning — the engine's current eval parameters (defaults or
    // whatever's applied) plus whether a tuned set is stored.
    getTuning = async (req: any, res: any): Promise<any> => {
        try {
            const paramsPath = this.engineManager.engineOptions?.evalParamsPath ?? null;
            const main: any = this.engineManager.getEngine("Main");

            let params: number[] = [];
            if (main && typeof main.getEvalParams === "function") {
                params = await main.getEvalParams();
            }

            res.json({
                count: params.length,
                params,
                applied: !!(paramsPath && existsSync(paramsPath)),
                file: paramsPath ? path.basename(paramsPath) : null,
            });
        } catch (err: any) {
            this.notifier.error("GetTuning Error:", err);
            res.status(500).json({error: err.message});
        }
    }

    // POST /api/engine/tuning { params: number[] | string } — persist a tuned
    // parameter vector and apply it to the running engine immediately.
    applyTuning = async (req: any, res: any): Promise<any> => {
        try {
            const paramsPath = this.engineManager.engineOptions?.evalParamsPath ?? null;
            if (!paramsPath) return res.status(503).json({error: "Eval params path not configured"});

            let {params} = req.body ?? {};
            if (typeof params === "string") {
                params = params.split(/\s+/).filter(Boolean).map(Number);
            }
            if (!Array.isArray(params) || params.length === 0 || params.some((n: any) => !Number.isFinite(n))) {
                return res.status(400).json({error: "params must be a non-empty array of integers (or a whitespace-separated string)"});
            }

            // Validate length against the engine's expected count when available.
            const main: any = this.engineManager.getEngine("Main");
            if (main && typeof main.getEvalParams === "function") {
                const current = await main.getEvalParams();
                if (current.length && params.length !== current.length) {
                    return res.status(400).json({error: `expected ${current.length} params, got ${params.length}`});
                }
            }

            await mkdir(path.dirname(paramsPath), {recursive: true});
            await writeFile(paramsPath, params.map((n: number) => Math.round(n)).join("\n") + "\n");

            // Live-apply to the managed engine so it takes effect without a respawn.
            let liveApplied = false;
            if (main && typeof main.setOption === "function") {
                try { await main.setOption("EvalParamsFile", paramsPath); liveApplied = true; } catch (_) {}
            }

            res.json({status: "success", count: params.length, liveApplied});
        } catch (err: any) {
            this.notifier.error("ApplyTuning Error:", err);
            res.status(500).json({error: err.message});
        }
    }

    // DELETE /api/engine/tuning — remove the stored tuned params. Compiled
    // defaults return on the next engine (re)start.
    clearTuning = async (req: any, res: any): Promise<any> => {
        try {
            const paramsPath = this.engineManager.engineOptions?.evalParamsPath ?? null;
            if (paramsPath && existsSync(paramsPath)) await unlink(paramsPath);
            res.json({status: "success", note: "Compiled defaults apply on the next engine restart."});
        } catch (err: any) {
            this.notifier.error("ClearTuning Error:", err);
            res.status(500).json({error: err.message});
        }
    }

    analyze = async (req: any, res: any): Promise<any> => {
        try {
            const {fen, depth = 10} = req.body ?? {};

            if (!fen) {
                return res.status(400).json({error: "FEN required"});
            }

            const mainEngine = this.engineManager.getEngine("Main");
            await mainEngine.position(fen);
            const {bestMove} = await mainEngine.go({depth, nodes: 0, moveTime: 0, whiteTime: 0, blackTime: 0, whiteIncrement: 0, blackIncrement: 0});

            res.json({bestMove, depth});
        } catch (err) {
            console.error("Analysis Error:", err);
            res.status(500).json({error: err.message});
        }
    }

    go = async (req: any, res: any): Promise<any> => {
        try {
            const {fen, moves, options} = req.body ?? {};
            const mainEngine = this.engineManager.getEngine("Main");

            await mainEngine.position(fen || "startpos", moves || []);
            const {bestMove} = await mainEngine.go({
                depth: 7, nodes: 0, moveTime: 0, whiteTime: 0, blackTime: 0, whiteIncrement: 0, blackIncrement: 0,
                ...(options || {}),
            });

            res.json({bestMove});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    }

    reset = async (req: any, res: any): Promise<any> => {
        await this.engineManager.getEngine("Main").uciNewGame();
        res.json({status: "reset_complete"});
    }

    bench = async (req: any, res: any): Promise<any> => {
        try {
            const {mode = "depth", depth = 10, timeLimit = 30000} = req.body ?? {};
            console.log(`Starting benchmark [Mode: ${mode}, Depth: ${depth}, Time: ${timeLimit}ms]...`);

            const benchId = `bench-${Date.now()}`;
            const benchEngine = await this.engineManager.registerEngine(benchId, this.mainEnginePath);
            // Translate the HTTP bench request into the unified go contract:
            // time mode caps by movetime, depth mode caps by depth (0 = unconstrained).
            const results = await benchEngine.bench({
                depth: mode === "time" ? 0 : depth,
                nodes: 0,
                moveTime: mode === "time" ? timeLimit : 0,
                whiteTime: 0, blackTime: 0, whiteIncrement: 0, blackIncrement: 0,
            });
            await this.engineManager.shutdownEngine(benchId);

            console.log("Benchmark results:", results);
            res.json({status: "success", data: results});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    }

    stream = async (req: any, res: any): Promise<any> => {
        try {
            let fen = req.query.fen || "startpos";
            if (fen === "start") {
                fen = "startpos";
            }
            const depth = parseInt(req.query.depth) || 20;

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders();

            const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const jewkiebot = this.engineManager.reserveEngine(`${streamId}-jb`, this.mainEnginePath);
            const stockfish = this.analyzer ? this.engineManager.reserveEngine(`${streamId}-sf`, this.analyzer.stockfishPath) : null;

            const cleanup = async () => {
                await this.engineManager.shutdownEngine(`${streamId}-jb`).catch(() => {
                });
                if (stockfish) {
                    await this.engineManager.shutdownEngine(`${streamId}-sf`).catch(() => {
                    });
                }
            };

            req.on("close", cleanup);

            const forwardLine = (engineName) => (line) => {
                if (line.startsWith("info depth") || line.startsWith("bestmove")) {
                    res.write(`data: ${JSON.stringify({engine: engineName, line})}\n\n`);
                }
            };

            console.log(`[Stream] Incoming stream request for FEN: ${fen}`);

            await jewkiebot.start();
            jewkiebot.on("line", forwardLine("jewkiebot"));
            await jewkiebot._sendCommand({ command: "setoption name OwnBook value false" });
            await jewkiebot.position(fen);
            await jewkiebot._sendCommand({ command: `go infinite` });

            if (stockfish) {
                await stockfish.start();
                stockfish.on("line", forwardLine("stockfish"));
                await stockfish.position(fen);
                await stockfish._sendCommand({ command: `go infinite` });
            }

        } catch (err) {
            console.error("Stream error:", err);
            res.write(`event: error\ndata: ${err.message}\n\n`);
            res.end();
        }
    }

    cancel = async (req: any, res: any): Promise<any> => {
        try {
            await this.engineManager.shutdownEngine("Main");
            await this.engineManager.registerEngine("Main", this.mainEnginePath);
            res.json({status: "success", message: "Engine reset to cancel task."});
        } catch (err) {
            console.error("Cancel failed:", err);
            res.status(500).json({error: err.message});
        }
    }

    buildEngine = async (req: any, res: any): Promise<any> => {
        try {
            const taskId = `build-engine-${Date.now()}`;
            await this.taskManager.createTask(taskId, "engine_build", {});

            res.json({status: "started", taskId});

            try {
                const {spawn} = await import("child_process");
                const buildScript = path.join(process.cwd(), "src", "scripts", "buildEngine.js");

                const child = spawn("bun", [buildScript], {cwd: path.join(process.cwd(), "src", "scripts")});

                let output = "";
                child.stdout.on("data", data => output += data.toString());
                child.stderr.on("data", data => output += data.toString());

                child.on("close", async code => {
                    if (code === 0) {
                        await this.taskManager.updateTaskStatus(taskId, "COMPLETED", {output});
                    } else {
                        await this.taskManager.updateTaskStatus(taskId, "FAILED", {error: `Exit code ${code}`, output});
                    }
                });
            } catch (err) {
                await this.taskManager.updateTaskStatus(taskId, "FAILED", {error: err.message});
            }
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    }

}