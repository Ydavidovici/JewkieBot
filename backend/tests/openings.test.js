import { describe, it, expect, mock, beforeEach } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LichessBot } from "../src/lichessBot.js";
import { OPENINGS } from "../src/openings.js";
import { spawn } from "bun";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Opening Book Features", () => {
    describe("downloadBook.js", () => {
        it("should execute the script successfully without crashing", async () => {
            // We use a fast, tiny URL (the repo's README) just to test the streaming logic
            // without downloading a 15MB file and spamming Github in CI tests.
            const fakeUrl = "https://raw.githubusercontent.com/gmcheems-org/free-opening-books/master/README.md";
            const scriptPath = path.resolve(__dirname, "../src/scripts/downloadBook.js");
            
            const testOutPath = path.resolve(__dirname, "test-book-output.bin");
            const proc = spawn({
                cmd: ["bun", "run", scriptPath, fakeUrl],
                env: { ...process.env, BOOK_OUT_PATH: testOutPath },
                stdout: "pipe",
                stderr: "pipe"
            });
            
            const exitCode = await proc.exited;
            expect(exitCode).toBe(0);
            
            const stdout = await new Response(proc.stdout).text();
            expect(stdout).toContain("Successfully downloaded and saved");
            
            // Clean up the test artifact
            await Bun.file(testOutPath).delete().catch(() => {});
        }, 10000);
    });

    describe("LichessBot Autoplay Openings", () => {
        let fakeEngine;
        let bot;

        beforeEach(() => {
            fakeEngine = {
                position: mock(async () => {}),
                setOption: mock(async () => {}),
                start: mock(async () => {}),
                go: mock(async () => "a1a2"),
                goWithEval: mock(async () => ({ bestMove: "a1a2" }))
            };
            bot = new LichessBot("fake_token", () => fakeEngine, { maxConcurrentGames: 1 });
            bot.sendMove = mock(async () => true);
        });

        it("should force specific opening move if whiteOpeningId/blackOpeningId matches OPENINGS dict", async () => {
            // Sicilian is defined as: e2e4 c7c5
            bot.startAutoplay({ blackOpeningId: "sicilian" });
            bot.gameOpenings.set("game123", "sicilian");
            
            // Scenario: We are black. White just played e2e4.
            // Expected: Bot skips engine and instantly plays c7c5
            await bot.makeMove(fakeEngine, "game123", "startpos", "e2e4", "black", {}, 1000);
            
            expect(bot.sendMove).toHaveBeenCalledWith("game123", "c7c5");
            expect(fakeEngine.position).not.toHaveBeenCalled();
        });

        it("should fallback to engine if moves diverge from forced opening", async () => {
            bot.startAutoplay({ blackOpeningId: "sicilian" }); // e2e4 c7c5
            bot.gameOpenings.set("game123", "sicilian");
            
            // Scenario: White played d2d4 (diverged from e2e4)
            await bot.makeMove(fakeEngine, "game123", "startpos", "d2d4", "black", {}, 1000);
            
            // It should NOT force c7c5, but send the engine's move a1a2
            expect(bot.sendMove).toHaveBeenCalledWith("game123", "a1a2");
            // It SHOULD ask the engine
            expect(fakeEngine.position).toHaveBeenCalledWith("startpos", ["d2d4"]);
        });

        it("should fallback to engine if the specific opening is over", async () => {
            bot.startAutoplay({ blackOpeningId: "sicilian" }); // Najdorf
            bot.gameOpenings.set("game123", "sicilian");
            
            // Scenario: All moves of Najdorf have been played. Next move is White's. Then Black's turn again.
            const fullNajdorf = "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1e3";
            await bot.makeMove(fakeEngine, "game123", "startpos", fullNajdorf, "black", {}, 1000);
            
            expect(bot.sendMove).toHaveBeenCalledWith("game123", "a1a2");
            expect(fakeEngine.position).toHaveBeenCalledWith("startpos", fullNajdorf.split(" "));
        });

        it("should apply whiteOpeningId when playing as white and blackOpeningId when playing as black", async () => {
            bot.startAutoplay({ whiteOpeningId: "c4", blackOpeningId: "sicilian" });
            
            // White game (movesStr is empty initially)
            await bot.makeMove(fakeEngine, "gameW", "startpos", "", "white", {}, 1000);
            expect(bot.gameOpenings.get("gameW")).toBe("c4");
            expect(bot.sendMove).toHaveBeenCalledWith("gameW", "c2c4");
            
            // Black game (white played e2e4)
            await bot.makeMove(fakeEngine, "gameB", "startpos", "e2e4", "black", {}, 1000);
            expect(bot.gameOpenings.get("gameB")).toBe("sicilian");
            expect(bot.sendMove).toHaveBeenCalledWith("gameB", "c7c5");
        });
    });

    describe("All Configured Openings", () => {
        let fakeEngine;
        let bot;

        beforeEach(() => {
            fakeEngine = {
                position: mock(async () => {}),
                setOption: mock(async () => {}),
                start: mock(async () => {}),
                go: mock(async () => "a1a2"),
                goWithEval: mock(async () => ({ bestMove: "a1a2" }))
            };
            bot = new LichessBot("fake_token", () => fakeEngine, { maxConcurrentGames: 1 });
            bot.sendMove = mock(async () => true);
        });

        for (const [id, config] of Object.entries(OPENINGS)) {
            if (config.type === "category") continue;

            it(`should correctly play the first move for ${id} as white`, async () => {
                bot.startAutoplay({ whiteOpeningId: id });
                await bot.makeMove(fakeEngine, "test_w", "startpos", "", "white", {}, 1000);
                
                // If it's a valid opening, it should send the very first move
                expect(bot.sendMove).toHaveBeenCalledWith("test_w", config.moves[0]);
            });

            it(`should correctly play the first move for ${id} as black (if white plays book)`, async () => {
                // To test black, we assume white played the first move of the book.
                // If the book is only 1 move long, black's response falls back to engine.
                if (config.moves.length > 1) {
                    bot.startAutoplay({ blackOpeningId: id });
                    await bot.makeMove(fakeEngine, "test_b", "startpos", config.moves[0], "black", {}, 1000);
                    expect(bot.sendMove).toHaveBeenCalledWith("test_b", config.moves[1]);
                }
            });
        }
    });
});
