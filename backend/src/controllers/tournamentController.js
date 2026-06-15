import { CutechessManager } from "../cutechessManager.js";
import { taskManager } from "../taskManager.js";
import { PgnManager } from "../pgnManager.js";
import { dbClient } from "../dbClient.js";
import path from "node:path";
import fs from "node:fs";

const CUTECHESS = process.platform === "win32"
    ? path.join(process.cwd(), "..", "tools", "cutechess-1.4.0-win64", "cutechess-cli.exe")
    : "cutechess-cli";

const ENGINES_DIR = path.join(process.cwd(), "..", "engines");
const STORAGE_DIR = path.join(process.cwd(), "storage");

export const tournamentController = {
    async runGauntlet(req, res) {
        try {
            const { myEngine, opponents, tc, games, concurrency, preset } = req.body;
            
            const taskId = `tourney-${Date.now()}`;
            await taskManager.createTask(taskId, "tournament", req.body);

            res.json({ status: "started", taskId });

            // Background execution
            (async () => {
                const manager = new CutechessManager(CUTECHESS);
                
                // Track progress by intercepting stdout before it gets to console
                // CutechessManager emits elo_update, but we also want generic progress
                let completedGames = 0;
                
                const originalStdoutWrite = process.stdout.write;
                const progressInterceptor = (chunk, encoding, callback) => {
                    const text = chunk.toString();
                    if (text.includes("Finished game")) {
                        completedGames++;
                        await taskManager.updateTaskProgress(taskId, { completed: completedGames, total: games });
                    }
                    return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
                };
                process.stdout.write = progressInterceptor;

                try {
                    const now = new Date();
                    const pad = (n) => n.toString().padStart(2, "0");
                    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
                    const pgnOut = path.join(STORAGE_DIR, `tournament_${timestamp}.pgn`);

                    const rounds = Math.max(1, Math.ceil(parseInt(games, 10) / (opponents.length * 2)));

                    // Resolve full paths for opponents
                    const resolvedOpponents = opponents.map(opp => ({
                        name: opp.name,
                        path: path.isAbsolute(opp.path) ? opp.path : path.join(ENGINES_DIR, opp.path),
                        args: opp.args || [],
                        sshConfig: opp.sshConfig
                    }));

                    const resolvedMyEngine = {
                        name: myEngine.name,
                        path: path.isAbsolute(myEngine.path) ? myEngine.path : path.join(ENGINES_DIR, myEngine.path),
                        args: myEngine.args || [],
                        sshConfig: myEngine.sshConfig
                    };

                    const resultPgn = await manager.runGauntlet({
                        myEngine: resolvedMyEngine,
                        opponents: resolvedOpponents,
                        timeControl: tc || "10+0.1",
                        rounds,
                        concurrency: parseInt(concurrency || "2", 10),
                        pgnOut,
                        openingBook: { file: path.join(process.cwd(), "..", "tools", "UHO_4060_v1.epd"), format: "epd" }
                    });

                    // Auto ingest
                    const pgnManager = new PgnManager(dbClient);
                    const pgnContent = fs.readFileSync(resultPgn, "utf-8");
                    const ingestResults = await pgnManager.ingestPgnString(pgnContent);

                    await taskManager.updateTaskStatus(taskId, "COMPLETED", { 
                        pgnFile: resultPgn, 
                        ingested: ingestResults.success,
                        failed: ingestResults.failed
                    });
                } catch (err) {
                    console.error(`[Tournament ${taskId}] Failed:`, err);
                    await taskManager.updateTaskStatus(taskId, "FAILED", { error: err.message });
                } finally {
                    process.stdout.write = originalStdoutWrite;
                }
            })();

        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    },

    async runSelfPlay(req, res) {
        try {
            const { v1, v2, tc, games, depth, nodes } = req.body;
            
            const taskId = `selfplay-${Date.now()}`;
            await taskManager.createTask(taskId, "selfplay", req.body);

            res.json({ status: "started", taskId });

            // Background execution
            (async () => {
                const manager = new CutechessManager(CUTECHESS);
                
                let completedGames = 0;
                const originalStdoutWrite = process.stdout.write;
                const progressInterceptor = (chunk, encoding, callback) => {
                    const text = chunk.toString();
                    if (text.includes("Finished game")) {
                        completedGames++;
                        await taskManager.updateTaskProgress(taskId, { completed: completedGames, total: games });
                    }
                    return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
                };
                process.stdout.write = progressInterceptor;

                try {
                    const getEnginePath = (version) => {
                        const baseDir = path.join(ENGINES_DIR, "jewkiebot", "build");
                        return version ? path.join(baseDir, `jewkiebot-${version}${process.platform === "win32" ? ".exe" : ""}`) : path.join(baseDir, `jewkiebot${process.platform === "win32" ? ".exe" : ""}`);
                    };

                    const myEngine = {
                        name: `Jewkiebot-${v1 || "latest"}`,
                        path: getEnginePath(v1),
                        args: []
                    };
                    const opponent = {
                        name: `Jewkiebot-${v2 || "latest"}`,
                        path: getEnginePath(v2),
                        args: []
                    };

                    const rounds = Math.max(1, Math.ceil(parseInt(games, 10) / 2));
                    const pgnOut = path.join(STORAGE_DIR, `selfplay_${taskId}.pgn`);

                    const resultPgn = await manager.runGauntlet({
                        myEngine,
                        opponents: [opponent],
                        timeControl: tc || "10+0.1",
                        depth,
                        nodes,
                        rounds,
                        concurrency: 2,
                        pgnOut
                    });

                    // Auto ingest
                    const pgnManager = new PgnManager(dbClient);
                    const pgnContent = fs.readFileSync(resultPgn, "utf-8");
                    const ingestResults = await pgnManager.ingestPgnString(pgnContent);

                    await taskManager.updateTaskStatus(taskId, "COMPLETED", { 
                        pgnFile: resultPgn,
                        ingested: ingestResults.success
                    });
                } catch (err) {
                    console.error(`[SelfPlay ${taskId}] Failed:`, err);
                    await taskManager.updateTaskStatus(taskId, "FAILED", { error: err.message });
                } finally {
                    process.stdout.write = originalStdoutWrite;
                }
            })();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
};
