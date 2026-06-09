import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbClient } from "../dbClient.js";
import { PgnManager } from "../pgnManager.js";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const STORAGE_DIR = path.join(__dirname, "..", "..", "storage");

async function parseAndIngestPgn(filePath) {
    try {
        console.log(`Ingesting ${filePath}...`);
        const manager = new PgnManager(dbClient);
        const result = await manager.ingestPgnFile(filePath);
        
        console.log(`✅ Completed ${filePath}: ${result.success} saved, ${result.failed} failed.`);
        return true;
    } catch (err) {
        console.error(`❌ Error ingesting ${filePath}:`, err);
        return false;
    }
}

async function processDirectory(dirPath) {
    console.log(`Checking directory ${dirPath} for PGN files...`);
    if (!fsSync.existsSync(dirPath)) {
        console.log(`Directory not found: ${dirPath}`);
        return;
    }

    const files = await fs.readdir(dirPath);
    const pgnFiles = files.filter(f => f.endsWith(".pgn"));

    if (pgnFiles.length === 0) {
        console.log("No .pgn files found.");
        return;
    }

    for (const file of pgnFiles) {
        const fullFilePath = path.join(dirPath, file);
        const success = await parseAndIngestPgn(fullFilePath);
        
        if (success) {
            const ingestedDir = path.join(dirPath, "ingested");
            if (!fsSync.existsSync(ingestedDir)) fsSync.mkdirSync(ingestedDir);
            
            await fs.rename(fullFilePath, path.join(ingestedDir, file));
            console.log(`Moved ${file} to ${ingestedDir}/`);
        }
    }

    console.log(`\nAll PGN files in ${dirPath} have been ingested.`);
}

async function main() {
    const fileArg = process.argv[2];
    
    if (fileArg) {
        const fullPath = path.resolve(fileArg);
        if (!fsSync.existsSync(fullPath)) {
            console.error(`Path not found: ${fullPath}`);
            process.exit(1);
        }
        
        const stat = fsSync.statSync(fullPath);
        if (stat.isDirectory()) {
            await processDirectory(fullPath);
        } else {
            const success = await parseAndIngestPgn(fullPath);
            if (success) {
                const parentDir = path.dirname(fullPath);
                const ingestedDir = path.join(parentDir, "ingested");
                if (!fsSync.existsSync(ingestedDir)) fsSync.mkdirSync(ingestedDir);
                const fileName = path.basename(fullPath);
                await fs.rename(fullPath, path.join(ingestedDir, fileName));
                console.log(`Moved ${fileName} to ${ingestedDir}/`);
            }
        }
        return;
    }

    // Default behavior
    await processDirectory(STORAGE_DIR);
}

main().catch(console.error);
