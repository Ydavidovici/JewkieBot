import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const url = "https://zipproth.de/Brainfish/Cerebellum_Light_3Merge_200916.7z";
const enginesDir = path.resolve(__dirname, "../../../engines/jewkiebot");
const archivePath = path.join(enginesDir, "cerebellum.7z");
const finalBookPath = path.join(enginesDir, "book.bin");

// The 7z extractor is named differently across platforms/distros: `7zz` on
// Debian trixie's `7zip` package, `7z` on classic p7zip, `7za` on the standalone
// build. Pick whichever is on PATH.
function find7z() {
    for (const bin of ["7zz", "7z", "7za"]) {
        try {
            const r = spawnSync(bin, ["--help"], { stdio: "ignore" });
            if (!r.error) return bin;
        } catch (_) { /* try next */ }
    }
    return null;
}

async function run7z(bin, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { cwd: enginesDir, stdio: "inherit" });
        proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${bin} exited with code ${code}`));
        });
        proc.on("error", reject);
    });
}

async function downloadCerebellum() {
    console.log(`Downloading massive opening book from: ${url}`);
    console.log(`Target destination: ${finalBookPath}`);
    console.log(`Please wait, this is a ~74MB download that extracts to a ~170MB book (~11M entries)...`);
    
    try {
        const bin = find7z();
        if (!bin) {
            throw new Error("No 7z extractor found on PATH (tried 7zz, 7z, 7za). Install the '7zip' or 'p7zip-full' package.");
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
        }

        console.log("Saving compressed archive...");
        await Bun.write(archivePath, response);

        console.log(`Extracting archive with ${bin}...`);
        await run7z(bin, ["e", "-y", archivePath]);

        // The archive's internal filename has varied across releases, so find the
        // extracted .bin rather than assuming its name. Pick the largest (the book).
        const binCandidates = [];
        for (const f of await fs.readdir(enginesDir)) {
            const full = path.join(enginesDir, f);
            if (!f.toLowerCase().endsWith(".bin") || full === finalBookPath) continue;
            binCandidates.push({full, size: (await fs.stat(full)).size});
        }
        binCandidates.sort((a, b) => b.size - a.size);
        const extractedBin = binCandidates[0]?.full;

        if (existsSync(finalBookPath)) await fs.unlink(finalBookPath);

        if (extractedBin && existsSync(extractedBin)) {
            console.log(`Installing ${path.basename(extractedBin)} as book.bin...`);
            await fs.rename(extractedBin, finalBookPath);
        } else {
            throw new Error("Extraction produced no .bin file.");
        }

        console.log("Cleaning up archive...");
        await fs.unlink(archivePath).catch(() => {});

        console.log("\n✅ Successfully installed Cerebellum (huge) opening book!");
    } catch (err) {
        console.error("\n❌ Error:", err.message);
        process.exit(1);
    }
}

downloadCerebellum();
