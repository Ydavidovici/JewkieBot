import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const url = "https://zipproth.de/Brainfish/Cerebellum_Light_3Merge_200916.7z";
const enginesDir = path.resolve(__dirname, "../../../engines/myengine");
const archivePath = path.join(enginesDir, "cerebellum.7z");
const finalBookPath = path.join(enginesDir, "book.bin");

async function run7z(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn("7z", args, { cwd: enginesDir, stdio: "inherit" });
        proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`7z exited with code ${code}`));
        });
        proc.on("error", reject);
    });
}

async function downloadCerebellum() {
    console.log(`Downloading massive opening book from: ${url}`);
    console.log(`Target destination: ${finalBookPath}`);
    console.log(`Please wait, this is a ~45MB download that extracts to ~300MB...`);
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
        }
        
        console.log("Saving compressed archive...");
        await Bun.write(archivePath, response);
        
        console.log("Extracting archive...");
        await run7z(["e", "-y", archivePath]);
        
        console.log("Renaming extracted book to book.bin...");
        const extractedName = path.join(enginesDir, "Cerebellum3Merge.bin");
        
        if (existsSync(finalBookPath)) {
            await fs.unlink(finalBookPath);
        }
        
        if (existsSync(extractedName)) {
            await fs.rename(extractedName, finalBookPath);
        } else {
            console.warn("Could not find expected Cerebellum_Light_3Merge.bin, skipping rename.");
        }
        
        console.log("Cleaning up archive...");
        await fs.unlink(archivePath);
        
        console.log("\n✅ Successfully installed Cerebellum (huge) opening book!");
    } catch (err) {
        console.error("\n❌ Error:", err.message);
        process.exit(1);
    }
}

downloadCerebellum();
