import {describe, it, expect, beforeEach} from "bun:test";
import {classifyMove, GameAnalyzer} from "../src/gameAnalyzer.js";
import {UciEngine} from "../src/engineManager.js";

function createTestDbClient() {
    return {
        _players: [],
        _games: [],
        _moves: [],
        _evals: [],
        _id: 1,

        async seedGame({result = null, openingEco = null, openingName = null} = {}) {
            const player = { id: this._id++, name: `bot-${Math.random()}` };
            this._players.push(player);
            const game = {
                id: this._id++,
                whiteId: player.id,
                blackId: player.id,
                result,
                openingEco,
                openingName
            };
            this._games.push(game);
            return {player, game};
        },

        async insertGameMoves(moves) {
            this._moves.push(...moves);
        },

        async insertMoveEvals(evals) {
            this._evals.push(...evals);
        },

        async getGameMoves(gameId) {
            return this._moves.filter(m => m.gameId === gameId).sort((a,b) => a.ply - b.ply);
        },

        async getUnanalyzedGames() {
            const analyzedGameIds = new Set(this._evals.map(e => e.gameId));
            return this._games.filter(g => !analyzedGameIds.has(g.id));
        },

        async getStats() { return {}; }
    };
}

describe("classifyMove", () => {
    it("returns 'forced' if move is mate and diff is 0", () => {
        expect(classifyMove(100, 100, true)).toBe("forced");
    });
    it("returns 'blunder' if diff <= -300", () => {
        expect(classifyMove(100, -200, false)).toBe("blunder");
    });
    it("returns 'mistake' if diff <= -100", () => {
        expect(classifyMove(100, 0, false)).toBe("mistake");
    });
    it("returns 'inaccuracy' if diff <= -50", () => {
        expect(classifyMove(100, 40, false)).toBe("inaccuracy");
    });
    it("returns 'good' if diff > -50", () => {
        expect(classifyMove(100, 60, false)).toBe("good");
    });
    it("handles mate evaluations (mate in X)", () => {
        expect(classifyMove({mate: 2}, {mate: 2}, false)).toBe("good");
        expect(classifyMove({mate: 2}, {mate: 3}, false)).toBe("good");
        expect(classifyMove({mate: 2}, {mate: -2}, false)).toBe("blunder");
        expect(classifyMove({mate: -2}, {mate: -1}, false)).toBe("blunder"); 
    });
});

describe("GameAnalyzer", () => {
    let dbClient;
    let mockEngine;

    beforeEach(() => {
        dbClient = createTestDbClient();
        mockEngine = {
            init: async () => {},
            quit: async () => {},
            uciNewGame: async () => {},
            go: async () => ({
                bestMove: "e2e4",
                score: { cp: 50 },
                depth: 20
            })
        };
    });

    it("evaluates a single game and writes to move_evals", async () => {
        const {game} = await dbClient.seedGame();
        await dbClient.insertGameMoves([
            { game_id: game.id, ply: 1, uci: "e2e4", fen_after: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" }
        ]);

        const analyzer = new GameAnalyzer("fake-path", {dbClient, engine: mockEngine, depth: 20});
        
        // Mock getPositionEval
        analyzer._getPositionEval = async () => ({ score: { cp: 50 } });

        await analyzer.analyzeGame(game);
        
        const evals = dbClient._evals.filter(e => e.gameId === game.id);
        expect(evals).toHaveLength(1);
        expect(evals[0].ply).toBe(1);
        expect(evals[0].bestUci).toBe("e2e4");
        expect(evals[0].bestCp).toBe(50);
        expect(evals[0].playedCp).toBe(50);
        expect(evals[0].cpLoss).toBe(0);
        expect(evals[0].classification).toBe("good");
    });
    
    it("skips already analyzed games", async () => {
        const {game} = await dbClient.seedGame();
        await dbClient.insertMoveEvals([{ gameId: game.id, ply: 1, bestUci: "e2e4", bestCp: 50, playedCp: 50, cpLoss: 0, isMate: 0, classification: "good" }]);

        const analyzer = new GameAnalyzer("fake-path", {dbClient, engine: mockEngine, depth: 20});
        
        let called = false;
        analyzer.analyzeGame = async () => { called = true; };

        await analyzer.runOnce();
        
        expect(called).toBe(false);
    });
});
