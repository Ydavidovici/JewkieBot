import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINES_DIR = path.join(__dirname, "..", "..", "..", "engines");

const ENGINES = [
    { repo: "AndyGrant/Ethereal", name: "ethereal", match: "windows" },
    { repo: "official-stockfish/Stockfish", name: "stash", match: "windows" }, // using SF as placeholder for Stash if repo missing
    { repo: "TerjeKir/weiss", name: "weiss", match: "windows" },
    { repo: "lucametehau/CloverEngine", name: "clover", match: "windows" },
    { repo: "vshcherbyna/igel", name: "igel", match: "windows" },
    { repo: "Matthies/RubiChess", name: "rubichess", match: "windows" },
    { repo: "jhonnold/berserk", name: "berserk", match: "windows" },
    { repo: "Luecx/Koivisto", name: "koivisto", match: "windows" },
];

async function downloadEngine(engine) {
    console.log(`\nFetching latest release for ${engine.repo}...`);
    try {
        const res = await fetch(`https://api.github.com/repos/${engine.repo}/releases/latest`);
        if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
        const json = await res.json();
        
        let asset = json.assets.find(a => a.name.toLowerCase().includes(engine.match.toLowerCase()) && a.name.endsWith(".exe"));
        if (!asset) {
            asset = json.assets.find(a => a.name.toLowerCase().includes(engine.match.toLowerCase()) && a.name.endsWith(".zip"));
        }
        if (!asset) {
            // fallback
            asset = json.assets.find(a => a.name.toLowerCase().includes("windows") && a.name.endsWith(".zip"));
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
                // Windows 10+ has tar
                execSync(`tar -xf "${zipPath}" -C "${outDir}"`, { stdio: 'ignore' });
                await fs.unlink(zipPath); 
                console.log(`✅ Saved ${engine.name} (extracted)`);
            } catch (e) {
                console.error(`❌ Failed to extract ${asset.name}:`, e.message);
            }
        } else {
            const exePath = path.join(outDir, `${engine.name}.exe`);
            await fs.writeFile(exePath, Buffer.from(buffer));
            console.log(`✅ Saved ${engine.name}.exe`);
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
