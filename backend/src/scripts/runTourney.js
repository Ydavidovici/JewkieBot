import {spawn} from "bun";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execSync} from "node:child_process";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOOLS_DIR = path.join(__dirname, "../../../tools");
const ENGINES_DIR = path.join(__dirname, "../../../engines");

const CUTECHESS = path.join(TOOLS_DIR, "cutechess-1.4.0-win64/cutechess-cli.exe");
const BOOK_PATH = path.join(TOOLS_DIR, "UHO_4060_v1.epd");
const MY_ENGINE = path.join(ENGINES_DIR, "jewkiebot/build/jewkiebot.exe");
const STOCKFISH_PATH = path.join(ENGINES_DIR, "stockfish/stockfish/stockfish-windows-x86-64-avx2.exe");
const STORAGE_DIR = path.join(__dirname, "../storage");

function cleanupEngines() {
    console.log("\n🧹 Sweeping up orphaned engine processes...");
    try {
        execSync("taskkill /F /IM jewkiebot.exe /T", { stdio: "ignore" });
        execSync("taskkill /F /IM cutechess-cli.exe /T", { stdio: "ignore" });
        execSync("taskkill /F /IM stockfish-windows-x86-64-avx2.exe /T", { stdio: "ignore" });
        console.log("✅ Cleanup complete.");
    } catch (e) {}
}

process.on("SIGINT", () => { cleanupEngines(); process.exit(0); });
process.on("exit", () => { cleanupEngines(); });

async function runTournament() {
    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
        console.log(`📁 Created new storage directory at: ${STORAGE_DIR}`);
    }

    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const pgnFilename = path.join(STORAGE_DIR, `tournament_${timestamp}.pgn`);

    const args = [
        "-tournament", "gauntlet",

        "-engine", "name=JewkieBot", `cmd=${MY_ENGINE}`, "proto=uci",

        "-engine",
        "name=SF_Weak_d4",
        `cmd=${STOCKFISH_PATH}`,
        "proto=uci",
        "depth=4",

        "-engine",
        "name=SF_Medium_d7",
        `cmd=${STOCKFISH_PATH}`,
        "proto=uci",
        "depth=7",

        "-engine",
        "name=SF_Strong_d10",
        `cmd=${STOCKFISH_PATH}`,
        "proto=uci",
        "depth=10",

        "-each",
        "tc=60+2",

        "-rounds", "50",
        "-games", "2",
        "-repeat",
        "-concurrency", "2",
        "-ratinginterval", "10",
        "-pgnout", pgnFilename,

        "-openings",
        `file=${BOOK_PATH}`,
        "format=epd",
        "order=random",
        "plies=16"
    ];

    const cutechessProcess = spawn({
        cmd: [CUTECHESS, ...args],
        stdout: "pipe",
        stderr: "inherit",
    });

    const decoder = new TextDecoder();
    for await (const chunk of cutechessProcess.stdout) {
        process.stdout.write(decoder.decode(chunk));
    }

    const exitCode = await cutechessProcess.exited;
    console.log(`\nTournament finished with code ${exitCode}.`);
}

runTournament().catch(console.error);