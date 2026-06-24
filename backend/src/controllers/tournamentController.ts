import {CutechessManager} from "../cutechessManager.js";
import path from "node:path";
import fs from "node:fs";

const CUTECHESS = process.platform === "win32"
    ? path.join(process.cwd(), "..", "tools", "cutechess-1.4.0-win64", "cutechess-cli.exe")
    : "cutechess-cli";

const ENGINES_DIR = path.join(process.cwd(), "..", "engines");
const STORAGE_DIR = path.join(process.cwd(), "storage");

export class TournamentController {
    constructor(
        private taskManager: any,
        private pgnManager: any
    ) {}

    private attachProgressInterceptor(taskId: string, totalGames: number) {
        let completedGames = 0;
        const originalStdoutWrite = process.stdout.write;

        const progressInterceptor = (chunk: any, encoding: any, callback: any) => {
            const text = chunk.toString();
            if (text.includes("Finished game")) {
                completedGames++;
                this.taskManager.updateTaskProgress(taskId, {completed: completedGames, total: totalGames}).catch(console.error);
            }
            return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
        };

        process.stdout.write = progressInterceptor as any;

        return () => {
            process.stdout.write = originalStdoutWrite;
        };
    }

    runGauntlet = async (req: any, res: any) => {
        try {
            const {myEngine, opponents, tc, games, concurrency, preset} = req.body;

            const taskId = `tourney-${Date.now()}`;
            await this.taskManager.createTask(taskId, "tournament", req.body);

            res.json({status: "started", taskId});

            (async () => {
                const manager = new CutechessManager(CUTECHESS);
                const detach = this.attachProgressInterceptor(taskId, games);

                try {
                    const now = new Date();
                    const pad = (n: number) => n.toString().padStart(2, "0");
                    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
                    const pgnOut = path.join(STORAGE_DIR, `tournament_${timestamp}.pgn`);

                    const rounds = Math.max(1, Math.ceil(parseInt(games, 10) / (opponents.length * 2)));

                    const resolvedOpponents = opponents.map((opp: any) => {
                        const resolvedPath = path.isAbsolute(opp.path) ? opp.path : path.join(ENGINES_DIR, opp.path);
                        return {
                            name: opp.name,
                            path: resolvedPath,
                            args: opp.args || [],
                            sshConfig: { host: "olddesktop", enginePath: resolvedPath },
                        };
                    });

                    const resolvedMyEnginePath = path.isAbsolute(myEngine.path) ? myEngine.path : path.join(ENGINES_DIR, myEngine.path);

                    const resolvedMyEngine = {
                        name: myEngine.name,
                        path: resolvedMyEnginePath,
                        args: myEngine.args || [],
                        sshConfig: { host: "olddesktop", enginePath: resolvedMyEnginePath },
                    };

                    const resultPgn = await manager.runGauntlet({
                        myEngine: resolvedMyEngine,
                        opponents: resolvedOpponents,
                        timeControl: tc || "10+0.1",
                        rounds,
                        concurrency: parseInt(concurrency || "2", 10),
                        pgnOut,
                        openingBook: {file: path.join(process.cwd(), "..", "tools", "UHO_4060_v1.epd"), format: "epd"},
                    });

                    const pgnContent = fs.readFileSync(resultPgn, "utf-8");
                    const ingestResults = await this.pgnManager.ingestPgnString(pgnContent);

                    await this.taskManager.updateTaskStatus(taskId, "COMPLETED", {
                        pgnFile: resultPgn,
                        ingested: ingestResults.success,
                        failed: ingestResults.failed,
                    });
                } catch (err: any) {
                    console.error(`[Tournament ${taskId}] Failed:`, err);
                    await this.taskManager.updateTaskStatus(taskId, "FAILED", {error: err.message});
                } finally {
                    detach();
                }
            })();

        } catch (err: any) {
            res.status(500).json({error: err.message});
        }
    }

}
