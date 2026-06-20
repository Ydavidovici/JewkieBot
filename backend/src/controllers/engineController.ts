import {OPENINGS} from "../openings";
import {EngineManager} from "../engineManager.ts";
import {Notifier} from "../notifier.ts";
import {GameAnalyzer} from "../gameAnalyzer";
import path from "node:path";

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

    analyze = async (req: any, res: any): Promise<any> => {
        try {
            const {fen, depth = 10} = req.body ?? {};

            if (!fen) {
                return res.status(400).json({error: "FEN required"});
            }

            const mainEngine = this.engineManager.getEngine("Main");
            await mainEngine.position(fen);
            const bestMove = await mainEngine.go({depth});

            res.json({bestMove, depth});
        } catch (err) {
            console.error("Analysis Error:", err);
            res.status(500).json({error: err.message});
        }
    }

    runAnalysis = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) {
            return res.status(503).json({error: "Analysis not configured"});
        }
        if (this.analyzer.isRunning) {
            return res.status(400).json({error: "Analysis already running"});
        }

        try {
            const {playerName} = req.body;
            const taskId = `analysis-${Date.now()}`;
            
            await this.taskManager.createTask(taskId, "teacher_analysis", {playerName});

            res.json({status: "started", taskId});

            (async () => {
                try {
                    const interval = setInterval(async () => {
                        if (this.analyzer.isRunning) {
                            await this.taskManager.updateTaskProgress(taskId, this.analyzer.progress);
                        }
                    }, 2000);

                    await this.analyzer.analyzeAll(playerName || null);
                    clearInterval(interval);

                    await this.taskManager.updateTaskStatus(taskId, "COMPLETED", {
                        gamesAnalyzed: this.analyzer.progress.done,
                    });
                } catch (err) {
                    await this.taskManager.updateTaskStatus(taskId, "FAILED", {error: err.message});
                }
            })();
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    }

    stopAnalysis = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) {
            return res.status(503).json({error: "Analysis not configured"});
        }
        if (!this.analyzer.isRunning) {
            return res.json({status: "not_running"});
        }
        await this.analyzer.stop();
        res.json({status: "stopped"});
    }

    getAnalysisStatus = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) {
            return res.status(503).json({error: "Analysis not configured"});
        }
        res.json({running: this.analyzer.isRunning, progress: this.analyzer.progress});
    }

    go = async (req: any, res: any): Promise<any> => {
        try {
            const {fen, moves, options} = req.body ?? {};
            const mainEngine = this.engineManager.getEngine("Main");

            await mainEngine.position(fen || "startpos", moves || []);
            const bestMove = await mainEngine.go(options || {depth: 7});

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
            const {mode = "depth", depth = 10, timeLimit = 30000, evalTime = 2000} = req.body ?? {};
            console.log(`Starting benchmark [Mode: ${mode}, Depth: ${depth}, Time: ${timeLimit}ms]...`);

            const benchId = `bench-${Date.now()}`;
            const benchEngine = await this.engineManager.registerEngine(benchId, this.mainEnginePath);
            const results = await benchEngine.bench({mode, depth, timeLimit, evalTime});
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

    getAnalysisStats = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) return res.status(503).json({error: "Analysis not configured"});

        try {
            res.json(await this.analyzer.getStats());
        } catch (err) {
            console.error("[Analysis] getStats failed:", err);
            res.status(500).json({error: err.message});
        }
    }
}