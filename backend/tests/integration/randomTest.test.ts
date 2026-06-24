import {UciEngine} from "../../src/engineManager.ts";

const engine = new UciEngine();

// Add this listener to actually print the engine's text to our terminal!
engine.on("line", (line) => {
    console.log("[Engine Output]", line);
});

console.log("Starting 10-minute game test...");
console.time("Move Calculation Time");

const move = await engine.go({
    whiteTime: 600000,
    blackTime: 600000,
    whiteIncrement: 0,
    blackIncrement: 0,
    nodes: 0,
    depth:0,
    moveTime: 0
});

console.timeEnd("Move Calculation Time");
console.log("Best move found:", move);
// Important: we need to stop the engine after the test or the process hangs
await engine.stop();