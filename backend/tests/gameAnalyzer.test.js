import {describe, it, expect, beforeEach} from "bun:test";
import {Database} from "bun:sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {eq} from "drizzle-orm";
import {classifyMove, GameAnalyzer} from "../src/gameAnalyzer.js";
import {UciEngine} from "../src/engineManager.js";
import * as schema from "../db/schema.js";

// ---------------------------------------------------------------------------
// In-memory DB helpers
// ---------------------------------------------------------------------------

function createTestDb() {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
        CREATE TABLE players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            white_id INTEGER NOT NULL REFERENCES players(id),
            black_id INTEGER NOT NULL REFERENCES players(id),
            result TEXT,
            termination TEXT,
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            finished_at TEXT,
            source TEXT DEFAULT 'local',
            lichess_game_id TEXT UNIQUE,
            variant TEXT,
            rated INTEGER,
            time_control TEXT,
            white_rating INTEGER,
            black_rating INTEGER,
            opening_eco TEXT,
            opening_name TEXT
        );
        CREATE TABLE game_moves (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            ply INTEGER NOT NULL,
            uci TEXT NOT NULL,
            fen_after TEXT
        );
        CREATE INDEX game_idx ON game_moves(game_id);
        CREATE TABLE move_evals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            ply INTEGER NOT NULL,
            best_uci TEXT,
            best_cp INTEGER,
            played_cp INTEGER,
            cp_loss INTEGER,
            is_mate INTEGER DEFAULT 0,
            classification TEXT
        );
        CREATE INDEX move_evals_game_idx ON move_evals(game_id);
    `);
    return drizzle(sqlite, {schema});
}

async function seedGame(db, {result = null, openingEco = null, openingName = null} = {}) {
    const [player] = await db.insert(schema.players).values({name: `bot-${Math.random()}`}).returning();
    const [game]   = await db.insert(schema.games).values({
        whiteId: player.id,
        blackId: player.id,
        result,
        openingEco,
        openingName,
    }).returning();
    return {player, game};
}

// ---------------------------------------------------------------------------
// Mock engine (no real process)
// ---------------------------------------------------------------------------

function makeMockEngine(evalSequence) {
    return {
        calls: [],
        idx: 0,
        async uciNewGame() { this.calls.push("uciNewGame"); },
        async position(fen) { this.calls.push({type: "position", fen}); },
        async goWithEval(opts) {
            this.calls.push({type: "goWithEval", opts});
            const ev = evalSequence[this.idx++];
            return ev ?? {scoreCp: 0, isMate: false, bestMove: "e2e4"};
        },
        async stop() {},
        isShuttingDown: false,
    };
}

// ---------------------------------------------------------------------------
// Mock UCI process helpers (mirrored from engineManager.test.js)
// ---------------------------------------------------------------------------

function createMockProcess() {
    const stdinWrites = [];
    const stdoutQueue = [];
    let stdoutResolvers = [];
    let stdoutClosed = false;

    const stdout = (async function* () {
        while (true) {
            if (stdoutQueue.length > 0) {
                yield stdoutQueue.shift();
            } else if (stdoutClosed) {
                return;
            } else {
                await new Promise(r => stdoutResolvers.push(r));
            }
        }
    })();

    const proc = {
        pid: 99999,
        stdin: {
            write: (d) => { stdinWrites.push(d); },
            flush: () => {},
        },
        stdout,
        kill: () => {},
        exited: new Promise(() => {}),
        _stdinWrites: stdinWrites,
        _pushLine(line) {
            stdoutQueue.push(new TextEncoder().encode(line + "\n"));
            const r = stdoutResolvers.shift();
            if (r) r();
        },
        _close() {
            stdoutClosed = true;
            for (const r of stdoutResolvers) r();
            stdoutResolvers = [];
        },
    };
    return proc;
}

function makeSpawnFn() {
    const procs = [];
    const fn = (args) => {
        const p = createMockProcess();
        p._spawnArgs = args;
        procs.push(p);
        return p;
    };
    fn.processes = procs;
    return fn;
}

async function tick(ms = 5) {
    await new Promise(r => setTimeout(r, ms));
}

async function quickStart(engine, spawnFn) {
    const startP = engine.start();
    await tick();
    const proc = spawnFn.processes[spawnFn.processes.length - 1];
    proc._pushLine("uciok");
    proc._pushLine("readyok");
    await startP;
    return proc;
}

// ---------------------------------------------------------------------------
// classifyMove()
// ---------------------------------------------------------------------------

describe("classifyMove()", () => {
    it("returns null for null input",      () => expect(classifyMove(null)).toBeNull());
    it("returns null for undefined input", () => expect(classifyMove(undefined)).toBeNull());
    it("returns 'good' for cpLoss = 0",   () => expect(classifyMove(0)).toBe("good"));
    it("returns 'good' for cpLoss = 10",  () => expect(classifyMove(10)).toBe("good"));
    it("returns 'inaccuracy' for cpLoss = 11",  () => expect(classifyMove(11)).toBe("inaccuracy"));
    it("returns 'inaccuracy' for cpLoss = 50",  () => expect(classifyMove(50)).toBe("inaccuracy"));
    it("returns 'mistake' for cpLoss = 51",     () => expect(classifyMove(51)).toBe("mistake"));
    it("returns 'mistake' for cpLoss = 100",    () => expect(classifyMove(100)).toBe("mistake"));
    it("returns 'blunder' for cpLoss = 101",    () => expect(classifyMove(101)).toBe("blunder"));
    it("returns 'blunder' for cpLoss = 500",    () => expect(classifyMove(500)).toBe("blunder"));
});

// ---------------------------------------------------------------------------
// UciEngine.goWithEval()
// ---------------------------------------------------------------------------

describe("UciEngine.goWithEval()", () => {
    it("returns bestMove and scoreCp from 'score cp N' info line", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("info depth 10 seldepth 12 score cp 45 nodes 1000 nps 500000 time 50 pv e2e4 e7e5");
        proc._pushLine("bestmove e2e4 ponder e7e5");
        const result = await p;

        expect(result.bestMove).toBe("e2e4");
        expect(result.scoreCp).toBe(45);
        expect(result.isMate).toBe(false);
        await engine.stop();
    });

    it("handles negative score cp (side to move losing)", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("info depth 8 score cp -120 pv d7d5");
        proc._pushLine("bestmove d7d5");
        const result = await p;

        expect(result.scoreCp).toBe(-120);
        expect(result.isMate).toBe(false);
        await engine.stop();
    });

    it("encodes mate-in-N as 30000-N and sets isMate=true", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("info depth 6 score mate 3 pv e2e4 e7e5 d2d4");
        proc._pushLine("bestmove e2e4");
        const result = await p;

        expect(result.scoreCp).toBe(30_000 - 3);
        expect(result.isMate).toBe(true);
        await engine.stop();
    });

    it("encodes being-mated-in-N as -(30000+N)", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("info depth 5 score mate -2 pv e7e5");
        proc._pushLine("bestmove e7e5");
        const result = await p;

        // n=-2: -(30000 + n) = -(30000 - 2) = -29998
        // Ordering: mated-in-1 (-29999) < mated-in-2 (-29998), so sooner mate = worse ✓
        expect(result.scoreCp).toBe(-(30_000 - 2));
        expect(result.isMate).toBe(true);
        await engine.stop();
    });

    it("ignores lowerbound/upperbound lines and uses the exact score", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("info depth 10 score cp 200 lowerbound pv e2e4");
        proc._pushLine("info depth 10 score cp 300 upperbound pv e2e4");
        proc._pushLine("info depth 10 score cp 45 pv e2e4 e7e5");
        proc._pushLine("bestmove e2e4");
        const result = await p;

        expect(result.scoreCp).toBe(45);
        await engine.stop();
    });

    it("uses the last (deepest) info line when multiple depths are reported", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("info depth 5 score cp 30 pv g1f3");
        proc._pushLine("info depth 10 score cp 50 pv e2e4 e7e5");
        proc._pushLine("bestmove e2e4");
        const result = await p;

        expect(result.scoreCp).toBe(50);
        expect(result.bestMove).toBe("e2e4");
        await engine.stop();
    });

    it("returns null scoreCp when no info lines precede bestmove", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("bestmove e2e4");
        const result = await p;

        expect(result.scoreCp).toBeNull();
        expect(result.bestMove).toBe("e2e4");
        await engine.stop();
    });

    it("sends 'go movetime N' when moveTime option is given", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 1234});
        await tick();
        proc._pushLine("bestmove e2e4");
        await p;

        expect(proc._stdinWrites.at(-1)).toBe("go movetime 1234\n");
        await engine.stop();
    });

    it("sends 'go depth N' when depth option is given", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({depth: 18});
        await tick();
        proc._pushLine("bestmove e2e4");
        await p;

        expect(proc._stdinWrites.at(-1)).toBe("go depth 18\n");
        await engine.stop();
    });

    it("ignores multipv 2+ lines and only uses multipv 1", async () => {
        const spawnFn = makeSpawnFn();
        const engine  = new UciEngine("/fake", {spawnFn, handshakeTimeoutMs: 200});
        const proc    = await quickStart(engine, spawnFn);

        const p = engine.goWithEval({moveTime: 500});
        await tick();
        proc._pushLine("info depth 10 multipv 1 score cp 40 pv e2e4");
        proc._pushLine("info depth 10 multipv 2 score cp 20 pv d2d4");
        proc._pushLine("bestmove e2e4");
        const result = await p;

        expect(result.scoreCp).toBe(40);
        await engine.stop();
    });
});

// ---------------------------------------------------------------------------
// GameAnalyzer.analyzeGame()
// ---------------------------------------------------------------------------

describe("GameAnalyzer.analyzeGame()", () => {
    it("evaluates N+1 positions for N moves and writes N rows", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        await db.insert(schema.gameMoves).values([
            {gameId: game.id, ply: 1, uci: "e2e4", fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"},
            {gameId: game.id, ply: 2, uci: "e7e5", fenAfter: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"},
        ]);

        // 3 evals for 2 moves: startpos, after ply1, after ply2
        const mockEngine = makeMockEngine([
            {scoreCp:  30, isMate: false, bestMove: "e2e4"}, // startpos
            {scoreCp: -28, isMate: false, bestMove: "e7e5"}, // after e2e4 (black to move)
            {scoreCp:  25, isMate: false, bestMove: "g1f3"}, // after e7e5 (white to move)
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});
        await analyzer.analyzeGame(game.id);

        const goWithEvalCalls = mockEngine.calls.filter(c => c?.type === "goWithEval");
        expect(goWithEvalCalls).toHaveLength(3); // N+1

        const rows = await db.select().from(schema.moveEvals).where(eq(schema.moveEvals.gameId, game.id));
        expect(rows).toHaveLength(2);
    });

    it("computes CPL correctly: bestCp - (-afterSideCp)", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        await db.insert(schema.gameMoves).values([
            {gameId: game.id, ply: 1, uci: "e2e4", fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"},
        ]);

        // startpos: +50 for white; after e2e4: -48 from black's perspective
        // playedCp = -(-48) = 48; cpLoss = max(0, 50 - 48) = 2 → "good"
        const mockEngine = makeMockEngine([
            {scoreCp:  50, isMate: false, bestMove: "e2e4"},
            {scoreCp: -48, isMate: false, bestMove: "e7e5"},
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});
        await analyzer.analyzeGame(game.id);

        const [row] = await db.select().from(schema.moveEvals).where(eq(schema.moveEvals.gameId, game.id));
        expect(row.bestCp).toBe(50);
        expect(row.playedCp).toBe(48);   // -(-48)
        expect(row.cpLoss).toBe(2);
        expect(row.classification).toBe("good");
    });

    it("classifies blunders, mistakes, inaccuracies, and good moves", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        // Four moves each with a specific CPL:
        // ply1: cpLoss = 0 → good   (50 → played at 50, i.e. after=-50)
        // ply2: cpLoss = 30 → inaccuracy  (we need bestCp - playedCp = 30)
        // ply3: cpLoss = 80 → mistake
        // ply4: cpLoss = 150 → blunder
        const fens = [
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2",
            "rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 3",
            "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 4",
        ];
        await db.insert(schema.gameMoves).values(fens.map((fenAfter, i) => ({
            gameId: game.id, ply: i + 1, uci: "e2e4", fenAfter,
        })));

        // Build evals so CPL for each ply matches above:
        // ply1: before=50, after=-50 → playedCp=50, cpLoss=0
        // ply2: before=-50, after=20 → playedCp=-20, cpLoss=max(0,-50-(-20))=max(0,-30)=0? NO
        // Need: cpLoss = bestCp - playedCp = bestCp - (-afterCp)
        // ply2 (black to move): before=-50, afterCp=?; playedCp = -afterCp; cpLoss = -50 - (-afterCp) = -50 + afterCp
        // Want cpLoss=30 → afterCp = 30 + 50 = 80? Let me check: cpLoss = bestCp - playedCp = -50 - (-80) = -50+80 = 30 ✓
        // ply3 (white to move): before=80, afterCp=?; cpLoss = 80 - (-afterCp) = 80 + afterCp; want 80 → afterCp = 0
        // ply4 (black to move): before=0, afterCp=?; cpLoss = 0 - (-afterCp) = afterCp; want 150 → afterCp = 150
        //
        // So the eval sequence (6 positions for 4+1 evals... wait, we need N+1=5 evals):
        // posEvals[0] = startpos eval
        // posEvals[1] = after ply1
        // posEvals[2] = after ply2
        // posEvals[3] = after ply3
        // posEvals[4] = after ply4
        //
        // ply1: before=posEvals[0], after=posEvals[1]
        //   cpLoss = posEvals[0].scoreCp - (-posEvals[1].scoreCp) = 50 - 50 = 0 ✓
        //   → posEvals[0].scoreCp=50, posEvals[1].scoreCp=-50
        //
        // ply2: before=posEvals[1], after=posEvals[2]
        //   cpLoss = posEvals[1].scoreCp - (-posEvals[2].scoreCp) = -50 - (-80) = 30 ✓
        //   → posEvals[1].scoreCp=-50, posEvals[2].scoreCp=80
        //
        // ply3: before=posEvals[2], after=posEvals[3]
        //   cpLoss = 80 - (-posEvals[3].scoreCp) = 80+posEvals[3].scoreCp = 80 → posEvals[3].scoreCp=0
        //
        // ply4: before=posEvals[3], after=posEvals[4]
        //   cpLoss = 0 - (-posEvals[4].scoreCp) = posEvals[4].scoreCp = 150

        const mockEngine = makeMockEngine([
            {scoreCp:  50, isMate: false, bestMove: "e2e4"}, // posEvals[0]
            {scoreCp: -50, isMate: false, bestMove: "e7e5"}, // posEvals[1]
            {scoreCp:  80, isMate: false, bestMove: "g1f3"}, // posEvals[2]
            {scoreCp:   0, isMate: false, bestMove: "f8c5"}, // posEvals[3]
            {scoreCp: 150, isMate: false, bestMove: "c2c3"}, // posEvals[4]
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});
        await analyzer.analyzeGame(game.id);

        const rows = await db.select().from(schema.moveEvals)
            .where(eq(schema.moveEvals.gameId, game.id));

        expect(rows).toHaveLength(4);
        expect(rows[0].classification).toBe("good");
        expect(rows[1].classification).toBe("inaccuracy");
        expect(rows[2].classification).toBe("mistake");
        expect(rows[3].classification).toBe("blunder");
        expect(rows[0].cpLoss).toBe(0);
        expect(rows[1].cpLoss).toBe(30);
        expect(rows[2].cpLoss).toBe(80);
        expect(rows[3].cpLoss).toBe(150);
    });

    it("does nothing for a game with no moves", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        const mockEngine = makeMockEngine([]);
        const analyzer   = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});
        await analyzer.analyzeGame(game.id);

        const rows = await db.select().from(schema.moveEvals).where(eq(schema.moveEvals.gameId, game.id));
        expect(rows).toHaveLength(0);
        expect(mockEngine.calls.filter(c => c?.type === "goWithEval")).toHaveLength(0);
    });

    it("stops the eval chain at the first move with a null fenAfter", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        await db.insert(schema.gameMoves).values([
            {gameId: game.id, ply: 1, uci: "e2e4", fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"},
            {gameId: game.id, ply: 2, uci: "e7e5", fenAfter: null}, // chain breaks here
            {gameId: game.id, ply: 3, uci: "g1f3", fenAfter: "some_fen"},
        ]);

        const mockEngine = makeMockEngine([
            {scoreCp: 20, isMate: false, bestMove: "e2e4"}, // startpos
            {scoreCp: -18, isMate: false, bestMove: "e7e5"}, // after ply1
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});
        await analyzer.analyzeGame(game.id);

        // Only ply 1 gets an eval (ply 2 fenAfter is null so chain stops)
        const rows = await db.select().from(schema.moveEvals).where(eq(schema.moveEvals.gameId, game.id));
        expect(rows).toHaveLength(1);
        expect(rows[0].ply).toBe(1);
    });

    it("stores isMate=1 and correct bestUci when best position is a forced mate", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        await db.insert(schema.gameMoves).values([
            {gameId: game.id, ply: 1, uci: "e2e4", fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"},
        ]);

        const mateScore = 30_000 - 3; // mate in 3
        const mockEngine = makeMockEngine([
            {scoreCp: mateScore, isMate: true, bestMove: "d1h5"}, // mate in 3 from startpos
            {scoreCp: -50, isMate: false, bestMove: "g8f6"},
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});
        await analyzer.analyzeGame(game.id);

        const [row] = await db.select().from(schema.moveEvals).where(eq(schema.moveEvals.gameId, game.id));
        expect(row.isMate).toBe(1);
        expect(row.bestUci).toBe("d1h5");
        expect(row.bestCp).toBe(mateScore);
    });
});

// ---------------------------------------------------------------------------
// GameAnalyzer.analyzeAll()
// ---------------------------------------------------------------------------

describe("GameAnalyzer.analyzeAll()", () => {
    it("throws when called while already running", async () => {
        const db = createTestDb();

        // Slow engine: each goWithEval takes 30ms so the test can observe
        // isRunning=true before the first analyzeAll finishes.
        const slowEngine = {
            async uciNewGame() {},
            async position() {},
            async goWithEval() {
                await tick(30);
                return {scoreCp: 0, isMate: false, bestMove: "e2e4"};
            },
            async stop() { this.isShuttingDown = true; },
            isShuttingDown: false,
        };

        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
        const {game} = await seedGame(db);
        await db.insert(schema.gameMoves).values([
            {gameId: game.id, ply: 1, uci: "e2e4", fenAfter: fen},
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, engine: slowEngine, depth: 20});
        const running = analyzer.analyzeAll(); // gets stuck inside first goWithEval

        await tick(5); // let it enter goWithEval before we try a second call
        await expect(analyzer.analyzeAll()).rejects.toThrow("already running");

        // First analyzeAll finishes after ~60ms (2 goWithEval calls × 30ms each)
        await running;
        expect(analyzer.isRunning).toBe(false);
    });

    it("skips games that already have move_evals", async () => {
        const db = createTestDb();

        const {game: g1} = await seedGame(db);
        const {game: g2} = await seedGame(db);

        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
        await db.insert(schema.gameMoves).values([
            {gameId: g1.id, ply: 1, uci: "e2e4", fenAfter: fen},
            {gameId: g2.id, ply: 1, uci: "d2d4", fenAfter: fen},
        ]);

        // Pre-seed move_evals for g1 so it looks already analysed
        await db.insert(schema.moveEvals).values([
            {gameId: g1.id, ply: 1, bestUci: "e2e4", bestCp: 20, playedCp: 18, cpLoss: 2, isMate: 0, classification: "good"},
        ]);

        const mockEngine = {
            async uciNewGame() {},
            async position() {},
            async goWithEval() { return {scoreCp: 10, isMate: false, bestMove: "e2e4"}; },
            async stop() {},
            isShuttingDown: false,
        };

        const analyzer = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});

        // Intercept analyzeGame to track which game IDs are processed
        const originalAnalyzeGame = analyzer.analyzeGame.bind(analyzer);
        const analyzedIds = [];
        analyzer.analyzeGame = async (id) => {
            analyzedIds.push(id);
            return originalAnalyzeGame(id);
        };

        await analyzer.analyzeAll();

        expect(analyzedIds).not.toContain(g1.id);
        expect(analyzedIds).toContain(g2.id);
    });

    it("updates progress counters correctly", async () => {
        const db = createTestDb();
        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

        const {game: g1} = await seedGame(db);
        const {game: g2} = await seedGame(db);
        await db.insert(schema.gameMoves).values([
            {gameId: g1.id, ply: 1, uci: "e2e4", fenAfter: fen},
            {gameId: g2.id, ply: 1, uci: "d2d4", fenAfter: fen},
        ]);

        const mockEngine = makeMockEngine(Array(20).fill({scoreCp: 10, isMate: false, bestMove: "e2e4"}));
        const analyzer   = new GameAnalyzer("/fake/sf", {db, engine: mockEngine, depth: 20});

        await analyzer.analyzeAll();

        expect(analyzer.progress.done).toBe(2);
        expect(analyzer.progress.total).toBe(2);
        expect(analyzer.progress.currentGameId).toBeNull();
        expect(analyzer.isRunning).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// GameAnalyzer.getStats()
// ---------------------------------------------------------------------------

describe("GameAnalyzer.getStats()", () => {
    it("returns zero/null overall counts for an empty database", async () => {
        const db       = createTestDb();
        const analyzer = new GameAnalyzer("/fake/sf", {db, depth: 20});
        const stats    = await analyzer.getStats();

        expect(stats.overall).toBeDefined();
        expect(stats.byPhase).toEqual([]);
        expect(stats.bySide).toEqual([]);
        expect(stats.byOpening).toEqual([]);
        expect(stats.winLossCorrelation).toEqual([]);
    });

    it("aggregates total counts and classifications correctly", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        await db.insert(schema.moveEvals).values([
            {gameId: game.id, ply: 1, cpLoss: 5,   classification: "good"},
            {gameId: game.id, ply: 2, cpLoss: 30,  classification: "inaccuracy"},
            {gameId: game.id, ply: 3, cpLoss: 80,  classification: "mistake"},
            {gameId: game.id, ply: 4, cpLoss: 200, classification: "blunder"},
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, depth: 20});
        const stats    = await analyzer.getStats();

        expect(Number(stats.overall.gamesAnalyzed)).toBe(1);
        expect(Number(stats.overall.totalMoves)).toBe(4);
        expect(Number(stats.overall.blunders)).toBe(1);
        expect(Number(stats.overall.mistakes)).toBe(1);
        expect(Number(stats.overall.inaccuracies)).toBe(1);
        expect(Number(stats.overall.goodMoves)).toBe(1);
    });

    it("groups moves by phase correctly", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        await db.insert(schema.moveEvals).values([
            {gameId: game.id, ply:  5, cpLoss: 10, classification: "good"},        // opening
            {gameId: game.id, ply: 20, cpLoss: 10, classification: "good"},        // opening (boundary)
            {gameId: game.id, ply: 21, cpLoss: 50, classification: "inaccuracy"},  // middlegame
            {gameId: game.id, ply: 60, cpLoss: 50, classification: "inaccuracy"},  // middlegame (boundary)
            {gameId: game.id, ply: 61, cpLoss: 100, classification: "mistake"},    // endgame
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, depth: 20});
        const stats    = await analyzer.getStats();

        const phases = Object.fromEntries(stats.byPhase.map(p => [p.phase, p]));
        expect(Number(phases.opening.totalMoves)).toBe(2);
        expect(Number(phases.middlegame.totalMoves)).toBe(2);
        expect(Number(phases.endgame.totalMoves)).toBe(1);
    });

    it("groups by side (white=odd ply, black=even ply)", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db);

        await db.insert(schema.moveEvals).values([
            {gameId: game.id, ply: 1, cpLoss: 100, classification: "blunder"},  // white
            {gameId: game.id, ply: 2, cpLoss: 0,   classification: "good"},     // black
            {gameId: game.id, ply: 3, cpLoss: 50,  classification: "inaccuracy"}, // white
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, depth: 20});
        const stats    = await analyzer.getStats();

        const sides = Object.fromEntries(stats.bySide.map(s => [s.side, s]));
        expect(Number(sides.white.blunders)).toBe(1);
        expect(Number(sides.black.blunders)).toBe(0);
    });

    it("includes opening breakdown with eco and name", async () => {
        const db = createTestDb();
        const {game} = await seedGame(db, {result: "1-0", openingEco: "B20", openingName: "Sicilian Defense"});

        await db.insert(schema.moveEvals).values([
            {gameId: game.id, ply: 1, cpLoss: 50, classification: "inaccuracy"},
            {gameId: game.id, ply: 2, cpLoss: 120, classification: "blunder"},
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, depth: 20});
        const stats    = await analyzer.getStats();

        expect(stats.byOpening).toHaveLength(1);
        expect(stats.byOpening[0].eco).toBe("B20");
        expect(stats.byOpening[0].name).toBe("Sicilian Defense");
        expect(Number(stats.byOpening[0].blunders)).toBe(1);
    });

    it("reports win/loss correlation grouped by game result", async () => {
        const db = createTestDb();

        const {game: win}  = await seedGame(db, {result: "1-0"});
        const {game: loss} = await seedGame(db, {result: "0-1"});

        await db.insert(schema.moveEvals).values([
            {gameId: win.id,  ply: 1, cpLoss: 10,  classification: "good"},
            {gameId: loss.id, ply: 1, cpLoss: 200, classification: "blunder"},
        ]);

        const analyzer = new GameAnalyzer("/fake/sf", {db, depth: 20});
        const stats    = await analyzer.getStats();

        const byResult = Object.fromEntries(stats.winLossCorrelation.map(r => [r.result, r]));
        expect(parseFloat(byResult["1-0"].avgCpLoss)).toBeLessThan(parseFloat(byResult["0-1"].avgCpLoss));
    });
});
