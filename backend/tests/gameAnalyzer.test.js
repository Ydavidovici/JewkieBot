import {describe, it, expect, beforeEach} from "bun:test";
import {classifyMove, GameAnalyzer} from "../src/gameAnalyzer.js";

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

        async insertMoveEvals(gameId, evals) {
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
    it("returns 'good' if cpLoss <= 10", () => {
        expect(classifyMove(5)).toBe("good");
    });
    it("returns 'inaccuracy' if cpLoss <= 50", () => {
        expect(classifyMove(30)).toBe("inaccuracy");
    });
    it("returns 'mistake' if cpLoss <= 100", () => {
        expect(classifyMove(80)).toBe("mistake");
    });
    it("returns 'blunder' if cpLoss > 100", () => {
        expect(classifyMove(150)).toBe("blunder");
    });
    it("returns null if cpLoss is null", () => {
        expect(classifyMove(null)).toBeNull();
    });
});

describe("GameAnalyzer", () => {
    let dbClient;

    beforeEach(() => {
        dbClient = createTestDbClient();
    });

    it("evaluates a single game and writes to move_evals", async () => {
        const {game} = await dbClient.seedGame();
        await dbClient.insertGameMoves([
            { gameId: game.id, ply: 1, uci: "e2e4", fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" }
        ]);

        const analyzer = new GameAnalyzer("fake-path", {dbClient, depth: 20});
        
        analyzer._getEngine = async () => ({
            uciNewGame: async () => {},
            position: async () => {},
            goWithEval: async () => ({ bestMove: "e2e4", scoreCp: 50, isMate: false })
        });

        await analyzer.analyzeGame(game.id);
        
        const evals = dbClient._evals.filter(e => e.gameId === game.id);
        expect(evals).toHaveLength(1);
        expect(evals[0].ply).toBe(1);
        expect(evals[0].bestUci).toBe("e2e4");
        expect(evals[0].bestCp).toBe(50);
        expect(evals[0].playedCp).toBe(-50); // scoreCp from opponent's perspective gets negated
        expect(evals[0].cpLoss).toBe(100);    // 50 - (-50) = 100
        expect(evals[0].classification).toBe("mistake"); // 100 is mistake
    });
    
    it("skips already analyzed games", async () => {
        const {game} = await dbClient.seedGame();
        await dbClient.insertMoveEvals(game.id, [{ gameId: game.id, ply: 1, bestUci: "e2e4", bestCp: 50, playedCp: 50, cpLoss: 0, isMate: 0, classification: "good" }]);

        const analyzer = new GameAnalyzer("fake-path", {dbClient, depth: 20});
        
        let called = false;
        analyzer.analyzeGame = async () => { called = true; };

        await analyzer.analyzeAll(); // renamed from runOnce to analyzeAll
        
        expect(called).toBe(false);
    });
});
