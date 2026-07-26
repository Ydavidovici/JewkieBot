import {ApiHealthResponse} from "../../Shared/Types.ts";
import express from "express";
import cors from "cors";
import path from "node:path";
import {EngineManager, EngineCapReached} from "./engineManager.ts";
import {LichessBot} from "./lichessBot.ts";
import {Notifier, nullNotifier, wrapConsoleForNotifier, WebhookTransport, ConsoleTransport} from "./notifier";
import {GameAnalyzer} from "./gameAnalyzer.ts";
import {taskManager} from "./taskManager";
import {PgnManager} from "./pgnManager.js";
import {dbClient} from "./dbClient.js";
import {ChessComController} from "./controllers/chessComController.js";
import {TournamentController} from "./controllers/tournamentController.js";
import {SelfPlayController} from "./controllers/selfPlayController.ts";
import {TuningController} from "./controllers/tuningController.ts";
import {PgnController} from "./controllers/pgnController.js";
import {TasksController} from "./controllers/tasksController.js";
import {EngineController} from "./controllers/engineController.js";
import {GameAnalyzerController} from "./controllers/gameAnalyzerController.ts";
import {LichessController} from "./controllers/lichessController.ts";

export function createApp({engineManager, lichessEngineFactory, mainEnginePath, maxConcurrentGames = 5, getToken = () => process.env.lichess_api_token, BotClass = LichessBot, notifier = nullNotifier, analyzer = null}: any = {}) {
    const app = express();

    const engineController = new EngineController(engineManager, notifier, mainEnginePath, analyzer, taskManager);
    const gameAnalyzerController = new GameAnalyzerController(analyzer, taskManager);
    const lichessController = new LichessController(getToken, lichessEngineFactory, maxConcurrentGames, notifier, BotClass);
    const pgnManager = new PgnManager(dbClient);
    const tasksController = new TasksController(taskManager);
    const pgnController = new PgnController(taskManager, pgnManager);
    const chessComController = new ChessComController(pgnManager);
    const tournamentController = new TournamentController(taskManager, pgnManager);
    const selfPlayController = new SelfPlayController(taskManager, pgnManager, analyzer);
    const tuningController = new TuningController(
        taskManager, dbClient, engineManager,
        path.resolve(__dirname, "../../engines/jewkiebot/eval_params.txt"),
    );

    app.use(cors({
        origin: "*",
    }));

    app.use(express.json());

    // Log every error response (status >= 400) including the body, so you can see
    // why an API call failed from the terminal and any notifier transports.
    app.use((req: any, res: any, next: any) => {
        const origJson = res.json.bind(res);
        res.json = (payload: any) => {
            if (res.statusCode >= 400) {
                notifier.error(`[API] ${req.method} ${req.originalUrl} → ${res.statusCode}`, {
                    status: res.statusCode,
                    body: payload,
                });
            }
            return origJson(payload);
        };
        next();
    });

    let lichessBotInstance = null;

    app.get("/api/health", (req: any, res: any) => {
        try {
            const mainEngine = engineManager.getEngine("Main");

            res.json({
                status: "ok",
                engine: mainEngine.ready ? "ready" : "starting",
                engineCount: engineManager.count(),
                botRunning: !!lichessBotInstance,
                activeGames: lichessBotInstance ? lichessBotInstance.activeGames.size : 0,
                uptimeSec: Math.round(process.uptime()),
            } satisfies ApiHealthResponse);
        } catch (err) {
            res.status(503).json({status: "degraded", error: err.message});
        }
    });

    app.get("/api/openings", engineController.getOpenings);
    app.post("/api/engine/build", engineController.buildEngine);
    app.post("/api/engine/setoption", engineController.setOptions);
    app.get("/api/engine/tuning", engineController.getTuning);
    app.post("/api/engine/tuning", engineController.applyTuning);
    app.delete("/api/engine/tuning", engineController.clearTuning);
    app.get("/api/engine/tuning/status", tuningController.status);
    app.post("/api/engine/tuning/run", tuningController.run);
    app.post("/api/engine/tuning/stop", tuningController.stopRun);
    app.post("/api/engine/go", engineController.go);
    app.post("/api/engine/reset", engineController.reset);
    app.post("/api/engine/bench", engineController.bench);
    app.get("/api/engine/stream", engineController.stream);
    app.post("/api/engine/cancel", engineController.cancel);
    app.post("/api/engine/analysis", engineController.analyze);
    app.post("/api/analysis/run", gameAnalyzerController.run);
    app.post("/api/analysis/stop", gameAnalyzerController.stop);
    app.get("/api/analysis/status", gameAnalyzerController.status);
    app.get("/api/analysis/stats", gameAnalyzerController.stats);

    app.post("/api/lichess/start", lichessController.start);
    app.post("/api/lichess/stop", lichessController.stop);
    app.get("/api/lichess/status", lichessController.getStatus);
    app.post("/api/lichess/challenge/open", lichessController.openChallenge);
    app.post("/api/lichess/challenge/ai", lichessController.challengeAI);
    app.post("/api/lichess/challenge/weakest", lichessController.challengeWeakest);
    app.post("/api/lichess/autoplay/start", lichessController.startAutoplay);
    app.post("/api/lichess/autoplay/stop", lichessController.stopAutoplay);
    app.get("/api/lichess/autoplay/status", lichessController.getAutoPlayStatus);

    app.post("/api/chesscom/fetch", chessComController.fetchUserGames);

    app.post("/api/cutechess/gauntlet", tournamentController.runGauntlet);

    app.get("/api/selfplay/versions", selfPlayController.versions);
    app.post("/api/selfplay/run", selfPlayController.run);
    app.get("/api/selfplay/stream/:taskId", selfPlayController.stream);
    app.get("/api/selfplay/games/:taskId", selfPlayController.games);
    app.post("/api/selfplay/stop/:taskId", selfPlayController.stopRun);

    app.post("/api/pgn/ingest", pgnController.ingestString);
    app.post("/api/pgn/ingest-file", pgnController.ingestFile);

    app.get("/api/tasks", tasksController.getAllTasks);
    app.get("/api/tasks/:id", tasksController.getTask);

    const distPath = path.resolve(import.meta.dir, "../../frontend/dist");
    app.use(express.static(distPath));
    app.get(/.*/, (req, res) => {
        if (req.path.startsWith("/api/")) {
            return res.status(404).json({error: "Not found"});
        }
        res.sendFile(path.join(distPath, "index.html"));
    });

    // Catch-all error handler. In Express 5 async handler rejections land here,
    // so an unhandled throw no longer kills the connection (or the process) —
    // it always logs and returns a JSON body the browser can display.
    app.use((err: any, req: any, res: any, next: any) => {
        notifier.error(`[API] Unhandled error on ${req.method} ${req.originalUrl}`, {
            message: err?.message,
            stack: err?.stack?.split("\n").slice(0, 5).join("\n"),
        });
        if (res.headersSent) return next(err);
        res.status(500).json({error: err?.message ?? "Internal Server Error"});
    });

    return {app, getBotInstance: () => lichessBotInstance, getAnalyzer: () => analyzer};
}

// Fetch the Linux Stockfish build into `stockfishPath`. Returns whether a binary
// ended up there. Run in the background so it never blocks server startup.
async function downloadStockfish(stockfishPath: string): Promise<boolean> {
    const {spawnSync} = await import("child_process");
    const fs = await import("fs");
    const destDir = path.dirname(stockfishPath);
    fs.mkdirSync(destDir, {recursive: true});

    const url = "https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64.tar";
    const tarPath = path.join(destDir, "stockfish.tar");

    console.log(`[Server] Downloading Stockfish in the background from ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    await Bun.write(tarPath, await res.arrayBuffer());

    const cmd = `tar xf ${tarPath} --strip-components=1 -C ${destDir} && mv ${destDir}/stockfish-ubuntu-x86-64 ${stockfishPath} 2>/dev/null || true && chmod +x ${stockfishPath} 2>/dev/null || true`;
    spawnSync("bash", ["-c", cmd], {stdio: "inherit"});
    fs.unlinkSync(tarPath);

    return Bun.file(stockfishPath).exists();
}

if (import.meta.main) {
    const PROD_PATH = path.join(import.meta.dir, "jewkiebot");
    const DEV_PATH = path.resolve(import.meta.dir, "../../engines/jewkiebot/build/jewkiebot.exe");
    const FIX_DEV_PATH = path.resolve(import.meta.dir, "../../../engines/jewkiebot/build/jewkiebot");

    let JEWKIEBOT_PATH = null;

    if (process.env.ENGINE_PATH) {
        if (await Bun.file(process.env.ENGINE_PATH).exists()) {
            console.log("✅ Using ENGINE_PATH from environment");
            JEWKIEBOT_PATH = process.env.ENGINE_PATH;
        } else {
            console.error(`❌ CRITICAL: ENGINE_PATH set but not found: ${process.env.ENGINE_PATH}`);
            process.exit(1);
        }
    } else if (await Bun.file(PROD_PATH).exists()) {
        console.log("✅ Running in Production Mode (Local Binary)");
        JEWKIEBOT_PATH = PROD_PATH;
    } else if (await Bun.file(DEV_PATH).exists()) {
        console.log("⚠️  Running in Dev Mode (External Binary)");
        JEWKIEBOT_PATH = DEV_PATH;
    } else if (await Bun.file(FIX_DEV_PATH).exists()) {
        console.log("⚠️  Running in Dev Mode (Deep Nested Fallback)");
        JEWKIEBOT_PATH = FIX_DEV_PATH;
    }

    if (!JEWKIEBOT_PATH) {
        console.error("❌ CRITICAL: Could not find chess engine binary!");
        process.exit(1);
    }
    console.log(`♟️  Engine Path: ${JEWKIEBOT_PATH}`);

    const transports = [];
    const webhookTransport = new WebhookTransport();

    if (webhookTransport.enabled) {
        transports.push(webhookTransport);
        console.log(`[Server] WebhookTransport enabled → ${webhookTransport.api.baseUrl}`);
    } else {
        // No webhook → send notifier events straight to the terminal so nothing is lost.
        transports.push(new ConsoleTransport());
        console.log("[Server] WebhookTransport disabled — notifier events will print to console.");
    }
    const notifier = new Notifier({transports});
    // Mirror console.* into the notifier only when a webhook consumes them. With the
    // ConsoleTransport active, wrapping would double-print every console line.
    const restoreConsole = webhookTransport.enabled ? wrapConsoleForNotifier(notifier) : () => {};

    const LICHESS_MAX_GAMES = parseInt(process.env.LICHESS_MAX_GAMES ?? "5", 10);
    const ENGINE_HARD_CAP = parseInt(process.env.ENGINE_HARD_CAP ?? String(LICHESS_MAX_GAMES + 3), 10);

    const engineManager = new EngineManager({
        maxEngines: ENGINE_HARD_CAP,
        notifier,
        engineOptions: {
            bookPath: path.resolve(__dirname, "../../engines/jewkiebot/book.bin"),
            evalParamsPath: path.resolve(__dirname, "../../engines/jewkiebot/eval_params.txt"),
        },
    });

    await engineManager.registerEngine("Main", JEWKIEBOT_PATH);

    const lichessEngineFactory = () => {
        // The reservation check is what enforces the cap. Existing engines are untouched.
        const label = `game-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (!engineManager.hasCapacity()) {
            throw new EngineCapReached(engineManager.maxEngines, engineManager.count());
        }
        // Delegate construction to the manager so per-game engines honour
        // REMOTE_ENGINE_ENABLED (SshUciEngine vs local UciEngine) exactly like
        // every other engine. Building a UciEngine directly here bypassed that
        // and forced games to always run on the local box.
        return engineManager.reserveEngine(label, JEWKIEBOT_PATH);
    };

    const isWindows = process.platform === "win32";
    const remoteEngines = process.env.REMOTE_ENGINE_ENABLED === "true";
    const defaultStockfishName = isWindows ? "stockfish.exe" : "stockfish";
    const defaultStockfishPath = path.resolve(import.meta.dir, `../../engines/stockfish/${defaultStockfishName}`);
    const STOCKFISH_PATH = process.env.STOCKFISH_PATH || defaultStockfishPath;
    const stockfishExists = await Bun.file(STOCKFISH_PATH).exists();

    // When engines run remotely (REMOTE_ENGINE_ENABLED), the analyzer's Stockfish
    // runs on the remote host over SSH, so a local binary isn't needed. Otherwise,
    // fetch it in the BACKGROUND — blocking startup on a ~100 MB download is what
    // makes the reverse proxy 502 on cold starts.
    if (!stockfishExists && !isWindows && !remoteEngines) {
        downloadStockfish(STOCKFISH_PATH)
            .then(ok => console.log(ok ? "[Server] Stockfish downloaded successfully." : "[Server] Stockfish download did not produce a binary."))
            .catch(err => console.error("[Server] Failed to auto-download stockfish:", err));
    }

    // Analysis is available when we have a usable Stockfish: a local binary, or a
    // remote one via SSH. studentPath = jewkiebot, so analysis records both
    // Stockfish's verdict (teacher) and jewkiebot's own eval/best-move (student).
    const analyzer = (stockfishExists || remoteEngines)
        ? new GameAnalyzer(STOCKFISH_PATH, {depth: 20, studentPath: JEWKIEBOT_PATH})
        : null;

    if (!analyzer) console.warn("[Server] Stockfish not found — analysis endpoints disabled until it's available.");

    const {app} = createApp({
        engineManager,
        lichessEngineFactory,
        mainEnginePath: JEWKIEBOT_PATH,
        maxConcurrentGames: LICHESS_MAX_GAMES,
        notifier,
        analyzer,
    });

    const PORT = process.env.PORT || 8000;

    const server = app.listen(PORT, "0.0.0.0", () => {
        console.log(`Backend listening on http://localhost:${PORT}`);
        notifier.info("[Server] Backend started", {
            port: PORT,
            engineCap: ENGINE_HARD_CAP,
            lichessMax: LICHESS_MAX_GAMES,
        });
    });

    let discordBot = null;
    if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID) {
        try {
            const {createDiscordBot} = await import("./discordBot.ts");
            discordBot = await createDiscordBot({
                token: process.env.DISCORD_BOT_TOKEN,
                channelId: process.env.DISCORD_CHANNEL_ID,
                notifier,
                healthUrl: process.env.HEALTH_URL ?? `http://localhost:${PORT}/api/health`,
                apiUrl: `http://localhost:${PORT}/api`,
            });
            console.log("[Server] Discord bot connected.");
        } catch (err) {
            console.error("[Server] Discord bot init failed:", err);
            notifier.warn("[Server] Discord bot init failed", {message: err?.message});
        }
    } else {
        console.log("[Server] Discord disabled (set DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID to enable).");
    }

    let shuttingDown = false;

    const shutdown = async (reason, exitCode = 0) => {
        if (shuttingDown) return;

        shuttingDown = true;

        console.log(`\n[Server] Shutting down (${reason})...`);
        try {
            await notifier.flush();
        } catch (_) {
        }
        try {
            server.close();
        } catch (_) {
        }
        try {
            if (analyzer) await analyzer.stop();
        } catch (_) {
        }
        try {
            await engineManager.shutdownAll();
        } catch (e) {
            console.error("[Server] shutdownAll error:", e);
        }
        if (discordBot) {
            try {
                await discordBot.stop();
            } catch (e) {
                console.error("[Server] Discord stop error:", e);
            }
        }
        try {
            restoreConsole();
        } catch (_) {
        }
        process.exit(exitCode);
    };

    process.on("SIGINT", () => shutdown("SIGINT", 0));
    process.on("SIGTERM", () => shutdown("SIGTERM", 0));

    const handleFatal = async (kind, err) => {
        console.error(`[Server] !! ${kind} !!`, err);
        try {
            await notifier.fatal(`[Server] ${kind}: process exiting`, {
                message: err?.message,
                stack: err?.stack?.split("\n").slice(0, 5).join("\n"),
            });
        } catch (_) {
        }
        await shutdown(kind, 1);
    };

    process.on("uncaughtException", (err) => handleFatal("uncaughtException", err));
    process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason))));
}
