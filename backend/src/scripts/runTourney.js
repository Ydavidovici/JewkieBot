import { CutechessManager } from "../cutechessManager.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { parseArgs } from "node:util";
import * as dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const TOOLS_DIR = path.join(__dirname, "../../../tools");
const ENGINES_DIR = path.join(__dirname, "../../../engines");
const STORAGE_DIR = path.join(__dirname, "../../storage");

const CUTECHESS = process.platform === "win32"
    ? path.join(TOOLS_DIR, "cutechess-1.4.0-win64/cutechess-cli.exe")
    : "cutechess-cli";
const BOOK_PATH = path.join(TOOLS_DIR, "UHO_4060_v1.epd");

const options = {
    games: { type: "string", default: "200" },
    tc: { type: "string", default: "10+0.1" },
    concurrency: { type: "string", default: "2" },
    preset: { type: "string", default: "diverse" }
};
const { values } = parseArgs({ options, args: process.argv.slice(2) });

const STOCKFISH_ENGINES = [
    { name: "SF-Depth2", exe: "stockfish/stockfish", depth: 2 },
    { name: "SF-Depth3", exe: "stockfish/stockfish", depth: 3 },
    { name: "SF-Depth4", exe: "stockfish/stockfish", depth: 4 },
    { name: "SF-Depth5", exe: "stockfish/stockfish", depth: 5 },
    { name: "SF-Depth6", exe: "stockfish/stockfish", depth: 6 },
    { name: "SF-Depth7", exe: "stockfish/stockfish", depth: 7 },
    { name: "SF-Depth8", exe: "stockfish/stockfish", depth: 8 },
];

const HUMAN_ENGINES = [
    { name: "Ethereal", exe: "/usr/games/ethereal", depth: 4 },
    { name: "Fruit", exe: "/usr/games/fruit", depth: 4 },
    { name: "Toga2", exe: "/usr/games/toga2", depth: 4 },
    { name: "Glaurung", exe: "/usr/games/glaurung", depth: 4 },
];

class TourneyManager extends CutechessManager {
    constructor() {
        super(CUTECHESS);
    }

    async runGauntletTournament() {
        if (!fs.existsSync(STORAGE_DIR)) {
            fs.mkdirSync(STORAGE_DIR, { recursive: true });
            console.log(`📁 Created new storage directory at: ${STORAGE_DIR}`);
        }

        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const pgnFilename = path.join(STORAGE_DIR, `tournament_${timestamp}.pgn`);

        const isRemote = process.env.REMOTE_ENGINE_ENABLED === "true";
        const baseRemoteDir = process.env.REMOTE_ENGINES_DIR || ENGINES_DIR; // fallback to assuming same path

        const getSshConfig = (remotePath) => {
            return isRemote ? {
                user: process.env.REMOTE_SSH_USER, // Optional
                host: process.env.REMOTE_SSH_HOST,
                keyPath: process.env.REMOTE_SSH_KEY_PATH, // Optional
                stockfishPath: remotePath // this is just the executable path on the remote machine
            } : null;
        };

        const myEngineRemotePath = isRemote && process.env.REMOTE_MY_ENGINE_PATH 
            ? process.env.REMOTE_MY_ENGINE_PATH 
            : path.join(baseRemoteDir, "jewkiebot", "build", "jewkiebot.exe");

        const myEngineLocalPath = process.platform === "win32" ? path.join(ENGINES_DIR, "jewkiebot", "build", "jewkiebot.exe") : path.join(ENGINES_DIR, "jewkiebot", "build", "jewkiebot");
        const myEngine = {
            name: "JewkieBot",
            path: isRemote ? myEngineRemotePath : myEngineLocalPath,
            sshConfig: getSshConfig(myEngineRemotePath),
            args: []
        };

        const opponents = [];
        const selectedEngines = values.preset === "stockfish" ? STOCKFISH_ENGINES : HUMAN_ENGINES;
        
        console.log(`Loading ${selectedEngines.length} opponents for preset: ${values.preset}...`);
        for (const eng of selectedEngines) {
            let activePath = eng.exe;
            if ((isRemote && process.env.REMOTE_OS === "linux") || (!isRemote && process.platform !== "win32")) {
                activePath = activePath.replace(".exe", "").replace(/\\/g, "/");
            }

            const isGlobalBinary = activePath.startsWith("/usr/");
            const localPath = isGlobalBinary ? activePath : path.join(ENGINES_DIR, activePath);
            let remotePath = isGlobalBinary ? activePath : path.join(baseRemoteDir, activePath);
            
            const finalPath = isRemote ? remotePath : localPath;

            if (!isRemote && !fs.existsSync(localPath)) {
                console.warn(`⚠️ Warning: ${eng.name} not found at ${localPath}. Did you run 'bun run download:engines'?`);
            } else {
                opponents.push({
                    name: eng.name,
                    path: finalPath,
                    sshConfig: getSshConfig(finalPath),
                    args: [`depth=${eng.depth}`]
                });
            }
        }

        const totalGames = parseInt(values.games, 10);
        const rounds = Math.max(1, Math.ceil(totalGames / (opponents.length * 2)));

        console.log(`\n🏆 Starting Tournament: ${rounds * opponents.length * 2} games requested.`);
        console.log(`Time Control: ${values.tc}, Concurrency: ${values.concurrency}, Remote SSH: ${isRemote}`);
        console.log(`PGN Output: ${pgnFilename}\n`);

        return this.runGauntlet({
            myEngine,
            opponents,
            timeControl: values.tc,
            rounds,
            concurrency: parseInt(values.concurrency, 10),
            pgnOut: pgnFilename,
            openingBook: { file: BOOK_PATH, format: "epd" }
        });
    }
}

async function main() {
    const manager = new TourneyManager();
    try {
        await manager.runGauntletTournament();
    } catch (e) {
        console.error("\n❌ Fatal Error during tournament:", e);
    }
}

main();