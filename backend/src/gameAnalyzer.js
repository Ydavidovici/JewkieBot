import {dbClient as defaultDbClient} from "./dbClient.js";
import {UciEngine} from "./engineManager.js";

export function classifyMove(cpLoss) {
    if (cpLoss === null || cpLoss === undefined) return null;
    if (cpLoss <= 10)  return "good";
    if (cpLoss <= 50)  return "inaccuracy";
    if (cpLoss <= 100) return "mistake";
    return "blunder";
}

export class GameAnalyzer {
    constructor(stockfishPath, options = {}) {
        this.stockfishPath = stockfishPath;
        // depth takes priority over moveTimeMs when both are set
        this.depth      = options.depth      ?? 20;
        this.moveTimeMs = options.moveTimeMs ?? null;
        this.spawnFn    = options.spawnFn    ?? null;
        this._dbClient  = options.dbClient   ?? defaultDbClient;
        this._engine    = options.engine     ?? null; // injectable for tests
        this._running   = false;
        this._aborted   = false;
        this.progress   = {total: 0, done: 0, currentGameId: null};
    }

    get isRunning() { return this._running; }

    async _getEngine() {
        if (!this._engine) {
            const opts = {label: "stockfish-analysis"};
            if (this.spawnFn) opts.spawnFn = this.spawnFn;
            this._engine = new UciEngine(this.stockfishPath, opts);
            await this._engine.start();
        }
        return this._engine;
    }

    async stop() {
        this._aborted = true;
        if (this._engine && !this._engine.isShuttingDown) {
            await this._engine.stop().catch(() => {});
            this._engine = null;
        }
        this._running = false;
    }

    async analyzeAll() {
        if (this._running) throw new Error("Analysis already running");
        this._running = true;
        this._aborted = false;

        try {
            // Find games that have no move_evals rows at all yet.
            const unanalyzed = await this._dbClient.getUnanalyzedGames();

            this.progress = {total: unanalyzed.length, done: 0, currentGameId: null};

            for (const {id} of unanalyzed) {
                if (this._aborted) break;
                this.progress.currentGameId = id;
                await this.analyzeGame(id);
                this.progress.done++;
            }
        } finally {
            this.progress.currentGameId = null;
            this._running = false;
        }
    }

    async analyzeGame(gameId) {
        const engine = await this._getEngine();

        const moves = await this._dbClient.getGameMoves(gameId);

        if (moves.length === 0) return;

        const evalOpts = this.moveTimeMs !== null
            ? {moveTime: this.moveTimeMs}
            : {depth: this.depth};

        // We evaluate N+1 positions for N plies.
        // posEvals[k] = Stockfish's evaluation of the position AFTER ply k
        //               (or the starting position for k=0).
        // scoreCp is always from the side-to-move's perspective.
        const posEvals = [];

        await engine.uciNewGame();
        await engine.position("startpos");
        posEvals.push(await engine.goWithEval(evalOpts));

        for (const move of moves) {
            if (this._aborted) return;
            if (!move.fenAfter) break; // chain requires FEN; stop here
            await engine.position(move.fenAfter);
            posEvals.push(await engine.goWithEval(evalOpts));
        }

        // Build eval rows for each ply that has a complete (before, after) pair.
        const rows = [];
        const pairs = posEvals.length - 1;

        for (let i = 0; i < pairs && i < moves.length; i++) {
            const before = posEvals[i];
            const after  = posEvals[i + 1];

            const bestCp = before.scoreCp;
            // `after.scoreCp` is from the opponent's perspective; negate to get
            // the mover's perspective so bestCp and playedCp share a sign convention.
            const playedCp = after.scoreCp !== null ? -after.scoreCp : null;
            // CPL = how many centipawns worse the played move was than the best move.
            const cpLoss = (bestCp !== null && playedCp !== null)
                ? Math.max(0, bestCp - playedCp)
                : null;

            rows.push({
                gameId,
                ply:            moves[i].ply,
                bestUci:        before.bestMove ?? null,
                bestCp,
                playedCp,
                cpLoss,
                isMate:         before.isMate ? 1 : 0,
                classification: classifyMove(cpLoss),
            });
        }

        if (rows.length > 0) {
            await this._dbClient.insertMoveEvals(gameId, rows);
        }
    }

    async getStats() {
        return await this._dbClient.getStats();
    }
}
