import { CutechessManager } from "../cutechessManager.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const PGN_OUT = path.join(__dirname, "..", "..", "..", "backend", "storage", "self_play.pgn");

const options = {
    v1: { type: "string" }, // white engine version (e.g. 2.1.0)
    v2: { type: "string" }, // black engine version (e.g. 2.0.0)
    games: { type: "string", default: "10" },
    tc: { type: "string", default: "10+0.1" }, // cutechess time control e.g. "10+0.1"
    depth: { type: "string" },
    nodes: { type: "string" },
};

const { values } = parseArgs({ options, args: process.argv.slice(2) });

function getEnginePath(version) {
    const baseDir = path.join(__dirname, "..", "..", "..", "engines", "jewkiebot", "build");
    return version ? path.join(baseDir, `jewkiebot-${version}`) : path.join(baseDir, "jewkiebot");
}

class SelfPlayManager extends CutechessManager {
    constructor(cutechessPath = "cutechess-cli") {
        super(cutechessPath);
    }

    async runSelfPlayMatch({ v1, v2, tc, games, pgnOut, depth, nodes }) {
        console.log(`[SelfPlay] Setting up match: Jewkiebot-${v1 || "latest"} vs Jewkiebot-${v2 || "latest"}`);
        console.log(`[SelfPlay] Config: ${games} games, tc=${tc}, depth=${depth || "unlim"}, nodes=${nodes || "unlim"}`);

        // Note: For version backtesting over SSH, you would ideally override stockfishPath
        // per version if both live on the remote. For now, we assume the paths resolve correctly.
        const sshConfig = process.env.REMOTE_ENGINE_ENABLED === "true" ? {
            user: process.env.REMOTE_SSH_USER,
            host: process.env.REMOTE_SSH_HOST,
            keyPath: process.env.REMOTE_SSH_KEY_PATH,
            stockfishPath: process.env.REMOTE_STOCKFISH_PATH 
        } : null;

        const myEngine = {
            name: `Jewkiebot-${v1 || "latest"}`,
            path: getEnginePath(v1),
            sshConfig,
            args: []
        };

        const opponent = {
            name: `Jewkiebot-${v2 || "latest"}`,
            path: getEnginePath(v2),
            sshConfig,
            args: []
        };

        const totalGames = parseInt(games, 10);
        // Cutechess plays 2 games per round by default in our config (switching colors)
        const rounds = Math.max(1, Math.ceil(totalGames / 2));

        return this.runGauntlet({
            myEngine,
            opponents: [opponent],
            timeControl: tc,
            depth,
            nodes,
            rounds,
            concurrency: 2, 
            pgnOut
        });
    }
}

async function main() {
    const manager = new SelfPlayManager();
    try {
        await manager.runSelfPlayMatch({
            v1: values.v1,
            v2: values.v2,
            tc: values.tc,
            games: values.games,
            depth: values.depth,
            nodes: values.nodes,
            pgnOut: PGN_OUT
        });
        console.log(`\n[SelfPlay] Match complete. Games saved to ${PGN_OUT}`);
    } catch (err) {
        console.error("\n[SelfPlay] Fatal error:", err);
    }
}

main();
