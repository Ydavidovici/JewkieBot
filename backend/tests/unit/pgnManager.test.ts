import {describe, it, expect, mock, beforeEach} from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {PgnManager, MOVE_CHUNK_SIZE, MOVE_CHUNK_CONCURRENCY} from "../../src/pgnManager.js";
import {dbClient} from "../../src/dbClient.js";

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
            const createGamesBulkMock = mock((payload) => Promise.resolve(payload.map(p => ({...p, id: 101}))));
            const insertMovesBulkMock = mock((moves: any[]) => Promise.resolve());

            const mockedDbClient = {
                ...dbClient,
                createGamesBulk: createGamesBulkMock,
                insertMovesBulk: insertMovesBulkMock,
            };

            const generator = new PgnManager(mockedDbClient);
            const result = await generator.ingestPgnString(pgnString);

            expect(result.success).toBe(1);
            expect(result.failed).toBe(0);

            // Verify createGamesBulk was called with correct metadata
            expect(createGamesBulkMock).toHaveBeenCalledTimes(1);
            const gamesPayload = createGamesBulkMock.mock.calls[0][0];
            expect(gamesPayload.length).toBe(1);
            expect(gamesPayload[0].whiteUsername).toBe("Carlsen,M");
            expect(gamesPayload[0].blackUsername).toBe("Bu Xiangzhi");
            expect(gamesPayload[0].result).toBe("1/2-1/2");

            // Verify insertMovesBulk was called with correct moves
            expect(insertMovesBulkMock).toHaveBeenCalledTimes(1);
            const movesPayload = insertMovesBulkMock.mock.calls[0][0];

            expect(movesPayload.length).toBe(6); // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6

            expect(movesPayload[0].uci).toBe("e2e4");
            expect(movesPayload[0].ply).toBe(1);
            expect(movesPayload[1].uci).toBe("e7e5");
            expect(movesPayload[1].ply).toBe(2);
        });

        // Large imports used to send 5 parallel chunks of 5,000 moves, which
        // occupied all of db-service's php-fpm workers and hit nginx's 300 s
        // timeout (504). Pin the chunk size and the in-flight cap.
        it("sends moves in bounded chunks with limited concurrency", async () => {
            // 63 games x 40 plies = 2,520 moves -> chunks of 1000, 1000, 520.
            const shuffle = Array.from({length: 10}, (_, i) =>
                `${2 * i + 1}. Nf3 Nf6 ${2 * i + 2}. Ng1 Ng8`).join(" ");
            const pgn = Array.from({length: 63}, (_, i) =>
                `[Event "Bulk ${i}"]\n[White "W${i}"]\n[Black "B${i}"]\n[Result "*"]\n\n${shuffle} *\n`).join("\n");

            let inFlight = 0;
            let maxInFlight = 0;
            const insertMovesBulkMock = mock(async (moves: any[]) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise(r => setTimeout(r, 5));
                inFlight--;
            });
            let nextId = 1;
            const mockedDbClient = {
                ...dbClient,
                createGamesBulk: mock((payload) => Promise.resolve(payload.map(p => ({...p, id: nextId++})))),
                insertMovesBulk: insertMovesBulkMock,
            };

            const result = await new PgnManager(mockedDbClient).ingestPgnString(pgn);

            expect(result.success).toBe(63);
            const sizes = insertMovesBulkMock.mock.calls.map(([moves]) => moves.length);
            expect(sizes).toEqual([1000, 1000, 520]);
            expect(Math.max(...sizes)).toBeLessThanOrEqual(MOVE_CHUNK_SIZE);
            expect(maxInFlight).toBeLessThanOrEqual(MOVE_CHUNK_CONCURRENCY);
        });

        // chess.js reports a missing Date header as "????.??.??"; that used
        // to throw "Invalid Date" and silently drop the game.
        it("imports games without a usable Date header", async () => {
            const pgn = `[Event "No date"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n` +
                `[Event "Placeholder date"]\n[Date "????.??.??"]\n[White "C"]\n[Black "D"]\n[Result "0-1"]\n\n1. d4 d5 0-1\n`;
            const createGamesBulkMock = mock((payload) => Promise.resolve(payload.map((p, i) => ({...p, id: i + 1}))));
            const mockedDbClient = {
                ...dbClient,
                createGamesBulk: createGamesBulkMock,
                insertMovesBulk: mock(() => Promise.resolve()),
            };

            const result = await new PgnManager(mockedDbClient).ingestPgnString(pgn);

            expect(result).toEqual({success: 2, failed: 0});
            for (const game of createGamesBulkMock.mock.calls[0][0]) {
                expect(Number.isNaN(Date.parse(game.started_at))).toBe(false);
            }
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
                started_at: "2026-06-08T10:00:00.000Z",
            }));

            const getGameMovesMock = mock(() => Promise.resolve([
                {ply: 1, uci: "e2e4", san: "e4"}, // if DB has SAN, great, if not we must generate it
                {ply: 2, uci: "e7e5", san: "e5"},
                {ply: 3, uci: "f1c4", san: "Bc4"},
                {ply: 4, uci: "b8c6", san: "Nc6"},
                {ply: 5, uci: "d1h5", san: "Qh5"},
                {ply: 6, uci: "g8f6", san: "Nf6"},
                {ply: 7, uci: "h5f7", san: "Qxf7#"},
            ]));

            const mockedDbClient = {
                ...dbClient,
                getGame: getGameMock,
                getGameMoves: getGameMovesMock,
            };

            const generator = new PgnManager(mockedDbClient);
            const pgnString = await generator.generatePgn([101]);

            expect(getGameMock).toHaveBeenCalledWith(101);
            expect(getGameMovesMock).toHaveBeenCalledWith(101);

            // Verify PGN string formatting
            expect(pgnString).toContain("[White \"JewkieBot\"]");
            expect(pgnString).toContain("[Black \"Stockfish_Weak\"]");
            expect(pgnString).toContain("[Result \"1-0\"]");
            // Depending on how we reconstruct moves, it should have the SAN moves:
            expect(pgnString).toContain("1. e4 e5");
            expect(pgnString).toContain("Qxf7# 1-0");
        });
    });
});
