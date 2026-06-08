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
};
const { values } = parseArgs({ options, args: process.argv.slice(2) });

const DIVERSE_ENGINES = [
    { name: "Stockfish", exe: "stockfish/stockfish.exe", depth: 4 },
    { name: "Weiss", exe: "weiss/weiss.exe", depth: 4 },
    { name: "Clover", exe: "clover/clover.exe", depth: 4 },
    { name: "Igel", exe: "igel/igel.exe", depth: 3 },
    { name: "RubiChess", exe: "rubichess/rubichess.exe", depth: 3 },
    { name: "Berserk", exe: "berserk/berserk.exe", depth: 4 },
    { name: "Koivisto", exe: "koivisto/koivisto.exe", depth: 3 },
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

        const myEngine = {
            name: "JewkieBot",
            path: isRemote ? myEngineRemotePath : path.join(ENGINES_DIR, "jewkiebot", "build", "jewkiebot.exe"),
            sshConfig: getSshConfig(myEngineRemotePath),
            args: []
        };

        const opponents = [];
        console.log("Loading 8 diverse open-source opponents...");
        for (const eng of DIVERSE_ENGINES) {
            const localPath = path.join(ENGINES_DIR, eng.exe);
            let remotePath = path.join(baseRemoteDir, eng.exe);
            
            if (isRemote && process.env.REMOTE_OS === "linux") {
                remotePath = remotePath.replace(/\.exe$/, "").replace(/\\/g, "/");
            }
            
            const activePath = isRemote ? remotePath : localPath;

            if (!isRemote && !fs.existsSync(localPath)) {
                console.warn(`⚠️ Warning: ${eng.name} not found at ${localPath}. Did you run 'bun run download:engines'?`);
            } else {
                opponents.push({
                    name: eng.name,
                    path: activePath,
                    sshConfig: getSshConfig(activePath),
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