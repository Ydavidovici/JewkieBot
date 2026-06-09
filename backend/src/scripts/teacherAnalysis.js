import {GameAnalyzer} from "../gameAnalyzer.js";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(__dirname, "..", "..", ".env")});

// Local fallback, but EngineManager will use SSH if process.env.REMOTE_ENGINE_ENABLED = true
const STOCKFISH_PATH = path.join(__dirname, "..", "..", "..", "engines", "stockfish", "stockfish", "stockfish-windows-x86-64-avx2.exe");

async function main() {
    console.log("🎓 Initializing Teacher Analysis (Stockfish 16.1)");

    // GameAnalyzer uses EngineManager internally. If REMOTE_ENGINE_ENABLED is true,
    // the engines will run on the olddesktop via SSH.
    const analyzer = new GameAnalyzer(STOCKFISH_PATH, {
        depth: 20,       // Deep analysis to act as a proper teacher
        concurrency: 4,   // Can process 4 games in parallel
    });

    console.log("Analyzing all unanalyzed games in the database...");

    const interval = setInterval(() => {
        if (analyzer.isRunning) {
            process.stdout.write(`\rProgress: ${analyzer.progress.done} / ${analyzer.progress.total} games analyzed. [Current: ${analyzer.progress.currentGameId || "none"}]`);
        }
    }, 2000);

    try {
        await analyzer.analyzeAll("jewkiebot");
        clearInterval(interval);
        console.log(`\n✅ Analysis complete! ${analyzer.progress.done} games evaluated.`);

        console.log("\n📊 Teacher Report:");
        try {
            const stats = await analyzer.getStats();
            console.log(JSON.stringify(stats, null, 2));
        } catch (err) {
            console.log("(Stats endpoint might not be fully configured yet on the database service.)");
        }
    } catch (e) {
        clearInterval(interval);
        console.error("\n❌ Teacher analysis encountered an error:", e);
    }
}

main();
