import { execSync } from 'child_process';
import * as fs from 'fs';
import { Chess } from 'chess.js';
import * as path from 'path';

// FIXME: this should use self-play and not be a .ts file

console.log("Generating dataset for Texel Tuning...");

// 1. Play Games
console.log("\n[1/3] Running CuteChess to generate self-play games...");
const cutechessPath = path.resolve(__dirname, '../../../tools/cutechess-1.4.0-win64/cutechess-cli.exe');
const enginePath = path.resolve(__dirname, '../../../engines/jewkiebot/build/jewkiebot.exe');
const bookPath = path.resolve(__dirname, '../../../tools/UHO_4060_v1.epd');
const pgnFile = path.resolve(__dirname, '../../generated_games.pgn');
const epdFile = path.resolve(__dirname, '../../../tools/tuning_dataset.epd');

const gamesToPlay = 100; // Fast initial batch

const cutechessArgs = [
    `-engine cmd="${enginePath}" name=JewkieBot`,
    `-engine cmd="${enginePath}" name=JewkieBot`,
    `-each proto=uci tc=inf depth=5`,
    `-games 2 -rounds ${gamesToPlay / 2} -repeat`,
    `-concurrency 4`,
    `-openings file="${bookPath}" format=epd order=random`,
    `-pgnout "${pgnFile}"`
].join(' ');

try {
    if (fs.existsSync(pgnFile)) fs.unlinkSync(pgnFile);
    console.log(`Starting ${gamesToPlay} games... this may take a minute.`);
    execSync(`"${cutechessPath}" ${cutechessArgs}`, { stdio: 'inherit' });
} catch (e) {
    console.log("Cutechess finished (or was interrupted). Processing the generated games...");
}

// 2. Parse PGN
console.log("\n[2/3] Parsing PGN to EPD...");
if (!fs.existsSync(pgnFile)) {
    console.error(`Error: ${pgnFile} not found. Did CuteChess fail?`);
    process.exit(1);
}

const pgnText = fs.readFileSync(pgnFile, 'utf-8');
const pgnManager = new (require('../pgnManager.js').PgnManager)();
const result = pgnManager.parsePgnToEpd(pgnText);

const epdLines = result.epdLines;
const positionCount = result.positionCount;
const gameCount = result.gameCount;

// 3. Save EPD
console.log(`\n[3/3] Saving ${positionCount} positions from ${gameCount} games to tuning_dataset.epd...`);
fs.writeFileSync(epdFile, epdLines.join('\n'));
console.log("Done! You can now run the tuner on the new dataset:");
console.log("> cd ../engines/jewkiebot/build");
console.log("> .\\perf_eval.exe ../../../tools/tuning_dataset.epd");
