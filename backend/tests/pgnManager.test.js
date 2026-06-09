import { describe, it, expect, mock, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { PgnManager } from "../src/pgnManager.js";
import { dbClient } from "../src/dbClient.js";

const DUMMY_PGN_PATH = path.join(__dirname, "dummy_test.pgn");

describe("PgnManager", () => {
    beforeEach(() => {
        mock.restore();
    });

    describe("Ingestion (PGN -> SQL)", () => {
        it("should parse a PGN string and insert games and moves into the database", async () => {
            const pgnString = `[Event "FIDE World Cup 2017"]
[Site "Tbilisi GEO"]
[Date "2017.09.09"]
[Round "4.3"]
[White "Carlsen,M"]
[Black "Bu Xiangzhi"]
[Result "1/2-1/2"]
[WhiteElo "2827"]
[BlackElo "2710"]
[EventDate "2017.09.03"]
[ECO "C55"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 1/2-1/2`;

            // Mock DB Client
            const createGameMock = mock(() => Promise.resolve({ id: 101 }));
            const insertGameMovesMock = mock(() => Promise.resolve());
            
            const mockedDbClient = {
                ...dbClient,
                createGame: createGameMock,
                insertGameMoves: insertGameMovesMock
            };

            const generator = new PgnManager(mockedDbClient);
            const result = await generator.ingestPgnString(pgnString);

            expect(result.success).toBe(1);
            expect(result.failed).toBe(0);

            // Verify createGame was called with correct metadata
            expect(createGameMock).toHaveBeenCalledTimes(1);
            const gamePayload = createGameMock.mock.calls[0][0];
            expect(gamePayload.whiteUsername).toBe("Carlsen,M");
            expect(gamePayload.blackUsername).toBe("Bu Xiangzhi");
            expect(gamePayload.result).toBe("1/2-1/2");

            // Verify insertGameMoves was called with correct moves
            expect(insertGameMovesMock).toHaveBeenCalledTimes(1);
            const movesPayload = insertGameMovesMock.mock.calls[0][1];
            expect(movesPayload.length).toBe(6); // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6
            expect(movesPayload[0].uci).toBe("e2e4");
            expect(movesPayload[0].ply).toBe(1);
            expect(movesPayload[1].uci).toBe("e7e5");
            expect(movesPayload[1].ply).toBe(2);
        });
    });

    describe("Export (SQL -> PGN)", () => {
        it("should fetch game data from SQL and construct a perfectly formatted PGN string", async () => {
            // Mock DB Client
            const getGameMock = mock(() => Promise.resolve({
                id: 101,
                whiteUsername: "JewkieBot",
                blackUsername: "Stockfish_Weak",
                result: "1-0",
                env: "local",
                timeControl: "10+0.1",
                started_at: "2026-06-08T10:00:00.000Z"
            }));

            const getGameMovesMock = mock(() => Promise.resolve([
                { ply: 1, uci: "e2e4", san: "e4" }, // if DB has SAN, great, if not we must generate it
                { ply: 2, uci: "e7e5", san: "e5" },
                { ply: 3, uci: "f1c4", san: "Bc4" },
                { ply: 4, uci: "b8c6", san: "Nc6" },
                { ply: 5, uci: "d1h5", san: "Qh5" },
                { ply: 6, uci: "g8f6", san: "Nf6" },
                { ply: 7, uci: "h5f7", san: "Qxf7#" }
            ]));

            const mockedDbClient = {
                ...dbClient,
                getGame: getGameMock,
                getGameMoves: getGameMovesMock
            };

            const generator = new PgnManager(mockedDbClient);
            const pgnString = await generator.generatePgn([101]);

            expect(getGameMock).toHaveBeenCalledWith(101);
            expect(getGameMovesMock).toHaveBeenCalledWith(101);

            // Verify PGN string formatting
            expect(pgnString).toContain('[White "JewkieBot"]');
            expect(pgnString).toContain('[Black "Stockfish_Weak"]');
            expect(pgnString).toContain('[Result "1-0"]');
            // Depending on how we reconstruct moves, it should have the SAN moves:
            expect(pgnString).toContain("1. e4 e5");
            expect(pgnString).toContain("Qxf7# 1-0");
        });
    });
});
