import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINES_DIR = path.join(__dirname, "..", "..", "..", "engines");

const isWin = process.platform === "win32";
const ENGINES = [
    { repo: "AndyGrant/Ethereal", name: "ethereal", match: isWin ? "windows" : "ubuntu" },
    { repo: "official-stockfish/Stockfish", name: "stash", match: isWin ? "windows" : "ubuntu" },
    { repo: "TerjeKir/weiss", name: "weiss", match: isWin ? "windows" : "linux" },
    { repo: "lucametehau/CloverEngine", name: "clover", match: isWin ? "windows" : "ubuntu" },
    { repo: "vshcherbyna/igel", name: "igel", match: isWin ? "windows" : "ubuntu" },
    { repo: "Matthies/RubiChess", name: "rubichess", match: isWin ? "windows" : "linux" },
    { repo: "jhonnold/berserk", name: "berserk", match: isWin ? "windows" : "ubuntu" },
    { repo: "Luecx/Koivisto", name: "koivisto", match: isWin ? "windows" : "ubuntu" },
];

async function downloadEngine(engine) {
    console.log(`\nFetching latest release for ${engine.repo}...`);
    try {
        const res = await fetch(`https://api.github.com/repos/${engine.repo}/releases/latest`);
        if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
        const json = await res.json();
        
        let asset = json.assets.find(a => a.name.toLowerCase().includes(engine.match.toLowerCase()) && (isWin ? a.name.endsWith(".exe") : !a.name.endsWith(".zip") && !a.name.endsWith(".tar.gz") && !a.name.endsWith(".txt")));
        if (!asset) {
            asset = json.assets.find(a => a.name.toLowerCase().includes(engine.match.toLowerCase()) && (a.name.endsWith(".zip") || a.name.endsWith(".tar.gz") || a.name.endsWith(".zst")));
        }
        if (!asset) {
            // fallback
            asset = json.assets.find(a => a.name.toLowerCase().includes(isWin ? "windows" : "ubuntu") && (a.name.endsWith(".zip") || a.name.endsWith(".tar.gz")));
        }
        
        if (!asset) {
            console.error(`❌ Could not find suitable asset for ${engine.name}`);
            return;
        }

        console.log(`Downloading ${asset.name}...`);
        const downloadRes = await fetch(asset.browser_download_url);
        const buffer = await downloadRes.arrayBuffer();

        const outDir = path.join(ENGINES_DIR, engine.name);
        await fs.mkdir(outDir, { recursive: true });

        if (asset.name.endsWith(".zip")) {
            const zipPath = path.join(outDir, asset.name);
            await fs.writeFile(zipPath, Buffer.from(buffer));
            console.log(`Extracting ${asset.name}...`);
            try {
                execSync(`unzip -o "${zipPath}" -d "${outDir}"`, { stdio: 'ignore' });
                await fs.unlink(zipPath); 
                console.log(`✅ Saved ${engine.name} (extracted)`);
            } catch (e) {
                console.error(`❌ Failed to extract ${asset.name}:`, e.message);
            }
        } else if (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".tar.zst") || asset.name.endsWith(".tgz")) {
            const tarPath = path.join(outDir, asset.name);
            await fs.writeFile(tarPath, Buffer.from(buffer));
            console.log(`Extracting ${asset.name}...`);
            try {
                execSync(`tar -xf "${tarPath}" -C "${outDir}"`, { stdio: 'ignore' });
                await fs.unlink(tarPath); 
                console.log(`✅ Saved ${engine.name} (extracted)`);
            } catch (e) {
                console.error(`❌ Failed to extract ${asset.name}:`, e.message);
            }
        } else {
            const ext = isWin ? ".exe" : "";
            const exePath = path.join(outDir, `${engine.name}${ext}`);
            await fs.writeFile(exePath, Buffer.from(buffer));
            if (!isWin) {
                execSync(`chmod +x "${exePath}"`);
            }
            console.log(`✅ Saved ${engine.name}${ext}`);
        }
    } catch (err) {
        console.error(`❌ Error downloading ${engine.name}:`, err.message);
    }
}

async function main() {
    console.log("Starting engine downloads...");
    for (const engine of ENGINES) {
        await downloadEngine(engine);
    }
    console.log("\nAll downloads completed.");
}

main();
