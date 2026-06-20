import {ApiHealthResponse} from "../../Shared/Types.ts";

import express from "express";
import cors from "cors";
import path from "node:path";
import {EngineManager, UciEngine, EngineCapReached} from "./engineManager.ts";
import {LichessBot} from "./lichessBot.js";
import {Notifier, nullNotifier, wrapConsoleForNotifier, WebhookTransport} from "./notifier.ts";
import {GameAnalyzer} from "./gameAnalyzer.js";
import {chessComController} from "./controllers/chessComController.js";
import {tournamentController} from "./controllers/tournamentController.js";
import {pgnController} from "./controllers/pgnController.js";
import {tasksController} from "./controllers/tasksController.js";
import {EngineController} from "./controllers/engineController.js";
import {taskManager} from "./taskManager";

export function createApp({engineManager, lichessEngineFactory, mainEnginePath, maxConcurrentGames = 4, getToken = () => process.env.lichess_api_token, BotClass = LichessBot, notifier = nullNotifier, analyzer = null}: any = {}) {
    const app = express();

    const engineController = new EngineController(engineManager, notifier, mainEnginePath, analyzer, taskManager);

    app.use(cors({
        origin: "*",
    }));

    app.use(express.json());

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
    app.post("/api/engine/go", engineController.go);
    app.post("/api/engine/reset", engineController.reset);
    app.post("/api/engine/bench", engineController.bench);
    app.get("/api/engine/stream", engineController.stream);
    app.post("/api/engine/cancel", engineController.cancel);
    app.post("/api/engine/analyze", engineController.analyze);
    app.post("/api/analysis/run", engineController.runAnalysis);
    app.post("/api/analysis/stop", engineController.stopAnalysis);
    app.get("/api/analysis/status", engineController.getAnalysisStatus);
    app.get("/api/analysis/stats", engineController.getAnalysisStats);


    // FIXME: refactor to use the lichessController
    app.post("/api/lichess/start", async (req, res) => {
        if (lichessBotInstance) {
            return res.status(400).json({error: "Bot is already running."});
        }

        const token = getToken();
        if (!token) {
            return res.status(400).json({error: "Missing Lichess Token"});
        }

        const instance = new BotClass(token, lichessEngineFactory, {maxConcurrentGames, notifier});
        try {
            await instance.start();
            lichessBotInstance = instance;
            notifier.info("[Server] Lichess bot started", {maxConcurrentGames});
            res.json({status: "success", message: `Lichess Bot started (max ${maxConcurrentGames} concurrent games).`});
        } catch (err) {
            console.error("Failed to start Lichess Bot:", err);
            notifier.error("[Server] Lichess bot failed to start", {message: err?.message});
            try {
                instance.stop();
            } catch (_) {
            }
            res.status(500).json({error: err.message});
        }
    });

    // FIXME: refactor to use the lichessController
    app.post("/api/lichess/stop", async (req, res) => {
        if (!lichessBotInstance) {
            return res.json({status: "ignored", message: "Bot was not running."});
        }

        try {
            if (typeof lichessBotInstance.stop === "function") {
                lichessBotInstance.stop();
            }
            lichessBotInstance = null;
            res.json({status: "success", message: "Lichess Bot stopped."});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    });

    // FIXME: refactor to use the lichessController
    app.get("/api/lichess/status", (req, res) => {
        const rateLimitedFor = lichessBotInstance ? lichessBotInstance._rateLimitRemainingSec() : 0;
        if (lichessBotInstance && !lichessBotInstance.botProfile) {
            lichessBotInstance._ensureProfile().catch(() => {
            });
        }
        res.json({
            running: !!lichessBotInstance,
            profile: lichessBotInstance ? lichessBotInstance.botProfile : null,
            activeGames: lichessBotInstance ? Array.from(lichessBotInstance.activeGames) : [],
            maxConcurrentGames: lichessBotInstance ? lichessBotInstance.maxConcurrentGames : maxConcurrentGames,
            rateLimitedFor,
            declinedCount: lichessBotInstance ? lichessBotInstance.recentlyDeclined.size : 0,
        });
    });

    // FIXME: refactor to use the lichessController
    app.post("/api/lichess/challenge/open", async (req, res) => {
        if (!lichessBotInstance) return res.status(400).json({error: "Bot not running"});
        const {limit = 180, increment = 0, rated = true} = req.body ?? {};
        try {
            const result = await lichessBotInstance.createOpenChallenge(limit, increment, rated);
            res.json({status: "success", data: result});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    });

    // FIXME: refactor to use the lichessController
    app.post("/api/lichess/challenge/ai", async (req, res) => {
        if (!lichessBotInstance) return res.status(400).json({error: "Bot not running"});
        const {level = 1, limit = 180, increment = 0} = req.body ?? {};
        try {
            const result = await lichessBotInstance.createAiChallenge(level, limit, increment);
            res.json({status: "success", data: result});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    });

    // FIXME: refactor to use the lichessController
    app.post("/api/lichess/challenge/weakest", async (req, res) => {
        if (!lichessBotInstance) return res.status(400).json({error: "Bot not running"});
        const {limit = 180, increment = 0, rated = true} = req.body ?? {};
        try {
            const result = await lichessBotInstance.huntWeakestBot(limit, increment, rated);
            res.json(result);
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    });

    // FIXME: refactor to use the lichessController
    app.post("/api/lichess/autoplay/start", (req, res) => {
        if (!lichessBotInstance) return res.status(400).json({error: "Bot not running"});
        const {
            limit = 180,
            increment = 2,
            rated = true,
            target = 1,
            mode = "near",
            window = 200,
            whiteOpeningId = null,
            blackOpeningId = null,
        } = req.body ?? {};
        lichessBotInstance.startAutoplay({limit, increment, rated, target, mode, window, whiteOpeningId, blackOpeningId});
        res.json({
            status: "success",
            message: `Autoplay started (${limit}+${increment} ${rated ? "rated" : "casual"}, target=${target})`,
            autoplay: lichessBotInstance.autoplayStatus(),
        });
    });

    // FIXME: refactor to use the lichessController
    app.post("/api/lichess/autoplay/stop", (req, res) => {
        if (!lichessBotInstance) return res.status(400).json({error: "Bot not running"});
        lichessBotInstance.stopAutoplay();
        res.json({status: "success", message: "Autoplay stopped"});
    });

    // FIXME: refactor to use the lichessController
    app.get("/api/lichess/autoplay/status", (req, res) => {
        if (!lichessBotInstance) return res.json({enabled: false, botRunning: false});
        res.json(lichessBotInstance.autoplayStatus());
    });

    app.post("/api/chesscom/fetch", chessComController.fetchUserGames);

    app.post("/api/cutechess/gauntlet", tournamentController.runGauntlet);
    app.post("/api/cutechess/selfplay", tournamentController.runSelfPlay);

    app.post("/api/pgn/ingest", pgnController.ingestString);
    app.post("/api/pgn/ingest-file", pgnController.ingestFile);

    app.get("/api/tasks", tasksController.getAllTasks);
    app.get("/api/tasks/:id", tasksController.getTask);

    const distPath = path.resolve(import.meta.dir, "../../frontend/dist");
    app.use(express.static(distPath));
    app.get(/.*/, (req, res) => {
        // Only serve index.html for non-API routes (API routes should 404 naturally if not matched above)
        if (req.path.startsWith("/api/")) {
            return res.status(404).json({error: "Not found"});
        }
        res.sendFile(path.join(distPath, "index.html"));
    });

    return {app, getBotInstance: () => lichessBotInstance, getAnalyzer: () => analyzer};
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
        console.log("[Server] WebhookTransport disabled (set API_NOTIFY_URL + API_NOTIFY_TOKEN to enable).");
    }
    const notifier = new Notifier({transports});
    const restoreConsole = wrapConsoleForNotifier(notifier);

    const LICHESS_MAX_GAMES = parseInt(process.env.LICHESS_MAX_GAMES ?? "4", 10);
    const ENGINE_HARD_CAP = parseInt(process.env.ENGINE_HARD_CAP ?? String(LICHESS_MAX_GAMES + 3), 10);

    const engineManager = new EngineManager({
        maxEngines: ENGINE_HARD_CAP,
        notifier,
        engineOptions: {
            bookPath: path.resolve(__dirname, "../../engines/jewkiebot/book.bin"),
        },
    });

    await engineManager.registerEngine("Main", JEWKIEBOT_PATH);

    const lichessEngineFactory = () => {
        // The reservation check is what enforces the cap. Existing engines are untouched.
        const label = `game-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (!engineManager.hasCapacity()) {
            throw new EngineCapReached(engineManager.maxEngines, engineManager.count());
        }
        return new UciEngine({
            cmd: JEWKIEBOT_PATH,
            notifier,
            label,
            bookPath: path.resolve(__dirname, "../../engines/jewkiebot/book.bin"),
        });
    };

    const isWindows = process.platform === "win32";
    const defaultStockfishName = isWindows ? "stockfish.exe" : "stockfish";
    const defaultStockfishPath = path.resolve(import.meta.dir, `../../engines/stockfish/${defaultStockfishName}`);
    const STOCKFISH_PATH = process.env.STOCKFISH_PATH || defaultStockfishPath;
    let stockfishExists = await Bun.file(STOCKFISH_PATH).exists();

    if (!stockfishExists && !isWindows) {
        console.log(`[Server] Stockfish not found at ${STOCKFISH_PATH}. Downloading...`);
        try {
            const {spawnSync} = await import("child_process");
            const fs = await import("fs");
            const destDir = path.dirname(STOCKFISH_PATH);
            fs.mkdirSync(destDir, {recursive: true});

            const url = "https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64.tar";
            const tarPath = path.join(destDir, "stockfish.tar");

            console.log(`[Server] Fetching ${url} using Bun...`);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

            const size = res.headers.get("content-length");
            const sizeMB = size ? (parseInt(size) / 1024 / 1024).toFixed(1) + " MB" : "a large file";
            console.log(`[Server] Downloading ${sizeMB}... this may take a minute and has no progress bar. Please wait...`);

            const buffer = await res.arrayBuffer();
            await Bun.write(tarPath, buffer);

            console.log(`[Server] Download complete. Extracting archive...`);
            const cmd = `tar xf ${tarPath} --strip-components=1 -C ${destDir} && mv ${destDir}/stockfish-ubuntu-x86-64 ${STOCKFISH_PATH} 2>/dev/null || true && chmod +x ${STOCKFISH_PATH} 2>/dev/null || true`;
            spawnSync("bash", ["-c", cmd], {stdio: "inherit"});

            fs.unlinkSync(tarPath);

            stockfishExists = await Bun.file(STOCKFISH_PATH).exists();
            if (stockfishExists) console.log("[Server] Stockfish downloaded successfully.");
        } catch (err) {
            console.error("[Server] Failed to auto-download stockfish:", err);
        }
    }

    const analyzer = stockfishExists
        ? new GameAnalyzer(STOCKFISH_PATH, {depth: 20})
        : null;

    if (!stockfishExists) console.warn("[Server] Stockfish not found — analysis endpoints disabled.");

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
            const {createDiscordBot} = await import("./discordBot.js");
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
