import { spawn } from "node:child_process";
import * as dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const user = process.env.REMOTE_SSH_USER;
const host = process.env.REMOTE_SSH_HOST;
const keyPath = process.env.REMOTE_SSH_KEY_PATH;
const stockfishPath = process.env.REMOTE_STOCKFISH_PATH;

if (!user || !host || !keyPath || !stockfishPath) {
    console.error("❌ Missing remote SSH configuration in .env");
    process.exit(1);
}

console.log(`🔍 Verifying remote installation on ${user}@${host}...`);

const sshCmd = [
    "ssh",
    "-i", keyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    `${user}@${host}`,
    stockfishPath
];

const child = spawn(sshCmd[0], sshCmd.slice(1));

let output = "";

child.stdout.on("data", (data) => {
    const text = data.toString();
    output += text;
    if (text.toLowerCase().includes("stockfish") || text.toLowerCase().includes("jewkiebot") || text.includes("id name")) {
        console.log("✅ Remote Engine execution and UCI stream successful.");
        child.stdin.write("quit\n");
    }
});

child.stderr.on("data", (data) => {
    console.error(`❌ Remote Error: ${data.toString().trim()}`);
});

child.on("close", (code) => {
    if (code !== 0) {
        console.log(`❌ SSH process exited with code ${code}. Check keys, paths, and connectivity.`);
    } else {
        console.log("✅ Verification complete.");
    }
    process.exit(code);
});

// Timeout after 10 seconds
setTimeout(() => {
    console.error("❌ Verification timed out. Engine did not respond to UCI command.");
    child.kill();
    process.exit(1);
}, 10000);

child.stdin.write("uci\n");
