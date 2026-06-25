import {CutechessManager} from "../cutechessManager.js";
import {spawn} from "bun";
import {sshTargetFromEnv, defaultRemoteConfig, absolutizeConfig, sshArgs} from "./selfPlayController.ts";

// Gauntlet tournaments (jewkiebot vs a field of engines), run fully on the remote
// host over SSH — same model as self-play, so nothing executes on the home box.
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

    // Read a file from the remote host over SSH (the match PGN lives there).
    private async fetchRemoteFile(target: any, remotePath: string): Promise<string> {
        const proc = spawn({cmd: sshArgs(target, `cat "${remotePath}"`), stdout: "pipe", stderr: "pipe"});
        const text = await new Response(proc.stdout).text();
        await proc.exited;
        return text;
    }

    runGauntlet = async (req: any, res: any) => {
        try {
            const target = sshTargetFromEnv();
            if (!target) {
                return res.status(503).json({error: "Remote execution not configured (set REMOTE_ENGINE_ENABLED=true and REMOTE_SSH_*). Tournaments only run on the remote host."});
            }

            const {myEngine, opponents, tc, games, concurrency} = req.body;
            // Resolve ~/$HOME against the remote home so cutechess gets real paths.
            const cfg = await absolutizeConfig(target, defaultRemoteConfig());
            const repoDir = cfg.repoDir;

            const taskId = `tourney-${Date.now()}`;
            await this.taskManager.createTask(taskId, "tournament", req.body);

            res.json({status: "started", taskId});

            (async () => {
                const manager = new CutechessManager(cfg.cutechess, target);
                const detach = this.attachProgressInterceptor(taskId, games);

                try {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                    const pgnOut = `${repoDir}/backend/storage/tournament_${timestamp}.pgn`;

                    const rounds = Math.max(1, Math.ceil(parseInt(games, 10) / (opponents.length * 2)));

                    // Engine paths resolve on the REMOTE host — opponent engines live
                    // under <repoDir>/engines (see fetch_engines.sh). Absolute/`~`
                    // paths are passed through untouched.
                    const remotePath = (p: string) => (p.startsWith("/") || p.startsWith("~")) ? p : `${repoDir}/engines/${p}`;
                    const resolvedOpponents = opponents.map((opp: any) => ({
                        name: opp.name,
                        path: remotePath(opp.path),
                        args: opp.args || [],
                    }));
                    const resolvedMyEngine = {
                        name: myEngine.name,
                        path: remotePath(myEngine.path),
                        args: myEngine.args || [],
                    };

                    const resultPgn = await manager.runGauntlet({
                        myEngine: resolvedMyEngine,
                        opponents: resolvedOpponents,
                        timeControl: tc || "10+0.1",
                        rounds,
                        concurrency: parseInt(concurrency || "2", 10),
                        pgnOut,
                        openingBook: cfg.openingBook ? {file: cfg.openingBook, format: "epd"} : null,
                    });

                    const pgnContent = await this.fetchRemoteFile(target, resultPgn);
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
