// Tactical sanity suite (docs/engine-improvements/README.md, "Testing harness"): does the engine still find known
// best moves? Not a strength measure: a quick "did I break tactics" check.
// A change that drops the solve count sharply is broken, even before SPRT.
//
//   bun scripts/tactics.ts                          # all tests/tactics/*.epd, 500 ms/position
//   bun scripts/tactics.ts --movetime 1000          # more time per position
//   bun scripts/tactics.ts tests/tactics/regressions.epd
//   bun scripts/tactics.ts --engine path/to/jewkiebot.exe
//
// Prints the failures and one summary line: "Tactics: X/Y solved ...".

import {readdirSync, existsSync} from "node:fs";
import {join, basename} from "node:path";
import {Uci} from "./lib/uci.ts";
import {readEpd} from "./lib/epd.ts";

const ENGINE_ROOT = join(import.meta.dir, "..");

const args = process.argv.slice(2);
let movetime = 500;
let engine = join(ENGINE_ROOT, "build", process.platform === "win32" ? "jewkiebot.exe" : "jewkiebot");
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--movetime") movetime = Number(args[++i]);
    else if (args[i] === "--engine") engine = args[++i];
    else files.push(args[i]);
}
if (files.length === 0) {
    const dir = join(ENGINE_ROOT, "tests", "tactics");
    files.push(...readdirSync(dir).filter(f => f.endsWith(".epd")).sort().map(f => join(dir, f)));
}
if (!existsSync(engine)) {
    console.error(`engine not found: ${engine} (build it with scripts/build.sh)`);
    process.exit(1);
}

const uci = new Uci(engine);
await uci.init({Threads: 1, Hash: 16, OwnBook: "false"});

let solved = 0, total = 0;
for (const file of files) {
    const positions = readEpd(file);
    let fileSolved = 0;
    const failures: string[] = [];
    for (const pos of positions) {
        const move = await uci.bestMove(pos.fen, {movetime});
        const ok = (pos.bm.length === 0 || pos.bm.includes(move)) && !pos.am.includes(move);
        if (ok) fileSolved++;
        else failures.push(`  ${pos.id || "?"}: played ${move}, wanted ${pos.bm.length ? pos.bm.join("/") : "not " + pos.am.join("/")}${pos.comment ? `  (${pos.comment})` : ""}`);
    }
    console.log(`${basename(file)}: ${fileSolved}/${positions.length}`);
    for (const f of failures) console.log(f);
    solved += fileSolved;
    total += positions.length;
}
await uci.quit();

console.log(`\nTactics: ${solved}/${total} solved (${(100 * solved / Math.max(total, 1)).toFixed(1)}%) at ${movetime} ms/position`);
