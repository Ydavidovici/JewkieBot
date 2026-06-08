import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbClient } from "../dbClient.js";
import { PgnGenerator } from "../pgnGenerator.js";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const STORAGE_DIR = path.join(__dirname, "..", "..", "storage");

async function parseAndIngestPgn(filePath) {
    console.log(`\n📄 Ingesting ${path.basename(filePath)}...`);
    const content = await fs.readFile(filePath, "utf-8");
    
    const generator = new PgnGenerator(dbClient);
    const result = await generator.ingestPgnString(content);
    
    console.log(`\n✅ Finished ingesting games from ${path.basename(filePath)}`);
    console.log(`Success: ${result.success}`);
    console.log(`Failed: ${result.failed}`);
}

async function main() {
    console.log("Checking storage directory for PGN files...");
    if (!fsSync.existsSync(STORAGE_DIR)) {
        console.log("Storage directory not found. No games to ingest.");
        return;
    }

    const files = await fs.readdir(STORAGE_DIR);
    const pgnFiles = files.filter(f => f.endsWith(".pgn"));

    if (pgnFiles.length === 0) {
        console.log("No .pgn files found in storage.");
        return;
    }

    for (const file of pgnFiles) {
        await parseAndIngestPgn(path.join(STORAGE_DIR, file));
        // Optionally rename or move the file so we don't ingest it twice
        const ingestedDir = path.join(STORAGE_DIR, "ingested");
        if (!fsSync.existsSync(ingestedDir)) fsSync.mkdirSync(ingestedDir);
        
        await fs.rename(path.join(STORAGE_DIR, file), path.join(ingestedDir, file));
        console.log(`Moved ${file} to storage/ingested/`);
    }

    console.log("\nAll PGN files have been ingested.");
}

main().catch(console.error);
