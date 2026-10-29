// Build a tactical test suite from the Lichess puzzle database.
//
//   bun scripts/tactics-fetch.ts [out.epd]     (default: tests/tactics/lichess.epd)
//
// Reads a sample of https://database.lichess.org/lichess_db_puzzle.csv.zst
// (the first 200k rows, about 40 s to stream; needs curl and zstd), cached in
// tools/downloads/. The public puzzle API was the first try, but it rate-limits
// anonymous clients after a few dozen requests, so the dump it is.
//
// In the dump, FEN is the position before the opponent's move and Moves is
// UCI: the first move is the opponent's, the second is the solution's first
// move. Each theme below gets puzzles that are well rated (popular, often
// played, settled rating) spread evenly across the rating range, one EPD line
// each:
//
//   <fen> bm d5e7; id "lichess-bYBNx"; c0 "mateIn2 1623";
//
// The output is checked in (it's small), so the suite stays fixed. Afterwards
// run scripts/tactics-verify.ts to drop puzzles Stockfish disagrees with.

import {Chess} from "../../../backend/node_modules/chess.js";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";

const ENGINE_ROOT = join(import.meta.dir, "..");
const OUT = process.argv[2] ?? join(ENGINE_ROOT, "tests", "tactics", "lichess.epd");
const CSV = join(ENGINE_ROOT, "tools", "downloads", "lichess_puzzles_head.csv");
const DUMP_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst";
const SAMPLE_ROWS = 200_000;

// theme -> how many puzzles to collect. Lichess theme keys.
const THEMES: Record<string, number> = {
    mateIn1: 15, mateIn2: 25, mateIn3: 15,
    fork: 20, pin: 15, skewer: 10, hangingPiece: 15,
    discoveredAttack: 15, sacrifice: 15, deflection: 10,
    attraction: 10, quietMove: 10, defensiveMove: 10, endgame: 15,
};
const MIN_POPULARITY = 90, MIN_PLAYS = 1000, MAX_RATING_DEVIATION = 80;

if (!existsSync(CSV)) {
    console.log(`streaming the first ${SAMPLE_ROWS} puzzles from ${DUMP_URL} ...`);
    mkdirSync(dirname(CSV), {recursive: true});
    const sh = Bun.spawnSync(["bash", "-c",
        `curl -s ${DUMP_URL} | zstd -dc 2>/dev/null | head -n ${SAMPLE_ROWS + 1} > "${CSV}"`]);
    if (!existsSync(CSV) || readFileSync(CSV).length === 0) {
        console.error(`download failed (needs curl and zstd on PATH): ${sh.stderr}`);
        process.exit(1);
    }
}

type Puzzle = {id: string, fen: string, moves: string[], rating: number, themes: string[]};

const puzzles: Puzzle[] = [];
for (const row of readFileSync(CSV, "utf8").split("\n").slice(1)) {
    const f = row.split(",");
    if (f.length < 8) continue;
    const [id, fen, moves, rating, deviation, popularity, plays, themes] = f;
    if (+popularity < MIN_POPULARITY || +plays < MIN_PLAYS || +deviation > MAX_RATING_DEVIATION) continue;
    puzzles.push({id, fen, moves: moves.split(" "), rating: +rating, themes: themes.split(" ")});
}
console.log(`${puzzles.length} puzzles pass the quality filter`);

// Play the opponent's move; the puzzle starts after it.
function puzzleFen(p: Puzzle): string | null {
    const chess = new Chess(p.fen);
    const m = p.moves[0];
    try { chess.move({from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4]}); } catch { return null; }
    // EPD uses the first four FEN fields (no move counters).
    return chess.fen().split(" ").slice(0, 4).join(" ");
}

const used = new Set<string>();
const lines: string[] = [];

for (const [theme, wanted] of Object.entries(THEMES)) {
    const pool = puzzles.filter(p => p.themes.includes(theme) && !used.has(p.id))
                        .sort((a, b) => a.rating - b.rating);
    let got = 0;
    // Evenly spaced picks through the rating-sorted pool: easy to hard.
    for (let i = 0; i < wanted && pool.length > 0; i++) {
        const p = pool[Math.floor((i + 0.5) * pool.length / wanted)];
        if (!p || used.has(p.id)) continue;
        const fen = puzzleFen(p);
        if (!fen || p.moves.length < 2) continue;
        used.add(p.id);
        lines.push(`${fen} bm ${p.moves[1]}; id "lichess-${p.id}"; c0 "${theme} ${p.rating}";`);
        got++;
    }
    console.log(`${theme}: ${got}/${wanted} (pool ${pool.length})`);
}

mkdirSync(dirname(OUT), {recursive: true});
writeFileSync(OUT, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} positions to ${OUT}`);
