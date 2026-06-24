import {GameAnalyzer} from "../gameAnalyzer.ts";

// REST surface for game analysis: kick off a Stockfish (+ jewkiebot student)
// pass over unanalyzed games, stop it, and read status/stats. Extracted from
// EngineController so analysis is a first-class controller of its own.
export class GameAnalyzerController {
    constructor(
        private analyzer: GameAnalyzer | null,
        private taskManager: any,
    ) {}

    // Analyze all unanalyzed games, optionally narrowed to one player's games
    // (e.g. a self-play version like "Jewkiebot-v2.1.0"). Runs in the background
    // and reports progress through the task system.
    run = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) {
            return res.status(503).json({error: "Analysis not configured"});
        }
        if (this.analyzer.isRunning) {
            return res.status(400).json({error: "Analysis already running"});
        }

        try {
            const {playerName} = req.body ?? {};
            const taskId = `analysis-${Date.now()}`;

            await this.taskManager.createTask(taskId, "teacher_analysis", {playerName});

            res.json({status: "started", taskId});

            (async () => {
                try {
                    const interval = setInterval(async () => {
                        if (this.analyzer!.isRunning) {
                            await this.taskManager.updateTaskProgress(taskId, this.analyzer!.progress);
                        }
                    }, 2000);

                    await this.analyzer!.analyzeAll(playerName || null);
                    clearInterval(interval);

                    await this.taskManager.updateTaskStatus(taskId, "COMPLETED", {
                        gamesAnalyzed: this.analyzer!.progress.done,
                    });
                } catch (err: any) {
                    await this.taskManager.updateTaskStatus(taskId, "FAILED", {error: err.message});
                }
            })();
        } catch (err: any) {
            res.status(500).json({error: err.message});
        }
    }

    stop = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) {
            return res.status(503).json({error: "Analysis not configured"});
        }
        if (!this.analyzer.isRunning) {
            return res.json({status: "not_running"});
        }
        await this.analyzer.stop();
        res.json({status: "stopped"});
    }

    status = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) {
            return res.status(503).json({error: "Analysis not configured"});
        }
        res.json({running: this.analyzer.isRunning, progress: this.analyzer.progress});
    }

    stats = async (req: any, res: any): Promise<any> => {
        if (!this.analyzer) return res.status(503).json({error: "Analysis not configured"});

        try {
            res.json(await this.analyzer.getStats());
        } catch (err: any) {
            console.error("[Analysis] getStats failed:", err);
            res.status(500).json({error: err.message});
        }
    }
}
