// Keep only the puzzles Stockfish agrees with, so every position in the suite
// has one clear best move. Rewrites the file in place and reports what it dropped.
//
//   bun scripts/tactics-verify.ts [file.epd] [--depth 18]
//   (default file: tests/tactics/lichess.epd; Stockfish from ../stockfish/)
//
// Run it with the machine otherwise idle: it uses a full CPU core.

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {Uci} from "./lib/uci.ts";
import {readEpd} from "./lib/epd.ts";

const ENGINE_ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
let depth = 18;
let file = join(ENGINE_ROOT, "tests", "tactics", "lichess.epd");
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--depth") depth = Number(args[++i]);
    else file = args[i];
}
const stockfish = join(ENGINE_ROOT, "..", "stockfish", process.platform === "win32" ? "stockfish.exe" : "stockfish");

const sf = new Uci(stockfish);
await sf.init({Threads: 1, Hash: 64});

const kept: string[] = [];
for (const pos of readEpd(file)) {
    const move = await sf.bestMove(pos.fen, {depth});
    if (pos.bm.includes(move)) kept.push(pos.line);
    else console.log(`drop ${pos.id}: Stockfish plays ${move}, puzzle says ${pos.bm.join("/")} (${pos.comment})`);
}
await sf.quit();

writeFileSync(file, kept.join("\n") + "\n");
console.log(`kept ${kept.length} positions in ${file}`);
