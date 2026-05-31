import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultTargetPath = path.resolve(__dirname, "../../../engines/jewkiebot/book.bin");
const targetPath = process.env.BOOK_OUT_PATH ? path.resolve(process.env.BOOK_OUT_PATH) : defaultTargetPath;

async function downloadBook() {
    const url = process.argv[2] || "https://github.com/gmcheems-org/free-opening-books/raw/main/books/bin/gm2001.bin";
    
    console.log(`Downloading opening book from: ${url}`);
    console.log(`Target destination: ${targetPath}`);
    console.log(`Please wait, downloading may take a moment depending on file size...`);
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
        }
        
        // Bun handles streaming response to disk extremely efficiently
        const bytesWritten = await Bun.write(targetPath, response);
        console.log(`\n✅ Successfully downloaded and saved ${(bytesWritten / 1024 / 1024).toFixed(2)} MB!`);
    } catch (err) {
        console.error("\n❌ Error downloading book:", err.message);
        process.exit(1);
    }
}

downloadBook();
