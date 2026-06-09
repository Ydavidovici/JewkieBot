import {dbClient as defaultDbClient} from "./dbClient.js";
import {EngineManager} from "./engineManager.js";

export function classifyMove(cpLoss) {
    if (cpLoss === null || cpLoss === undefined) return null;
    if (cpLoss <= 10) return "good";
    if (cpLoss <= 50) return "inaccuracy";
    if (cpLoss <= 100) return "mistake";
    return "blunder";
}

export class GameAnalyzer {
    constructor(stockfishPath, options = {}) {
        this.stockfishPath = stockfishPath;
        this.studentPath = options.studentPath ?? null;
        this.depth = options.depth ?? 20;
        this.moveTimeMs = options.moveTimeMs ?? null;
        this.spawnFn = options.spawnFn ?? null;
        this._dbClient = options.dbClient ?? defaultDbClient;
        this.concurrency = options.concurrency ?? 4;
        this._manager = new EngineManager({maxEngines: this.concurrency});
        this._running = false;
        this._aborted = false;
        this.progress = {total: 0, done: 0, currentGameId: null};
    }

    get isRunning() {
        return this._running;
    }

    async stop() {
        this._aborted = true;
        await this._manager.shutdownAll();
        this._running = false;
    }

    async analyzeAll(playerName = null) {
        if (this._running) throw new Error("Analysis already running");
        this._running = true;
        this._aborted = false;

        try {
            const unanalyzed = playerName
                ? await this._dbClient.getUnanalyzedGamesByPlayer(playerName)
                : await this._dbClient.getUnanalyzedGames();
            this.progress = {total: unanalyzed.length, done: 0, currentGameId: null};

            if (unanalyzed.length === 0) return;

            const engines = [];
            for (let i = 0; i < Math.min(this.concurrency, unanalyzed.length); i++) {
                const eng = this._manager.reserveEngine(`analysis-${i}`, this.stockfishPath);
                await eng.start();
                let student = null;
                if (this.studentPath) {
                    student = this._manager.reserveEngine(`student-${i}`, this.studentPath);
                    await student.start();
                }
                engines.push({ teacher: eng, student });
            }

            const processQueue = async (pair) => {
                while (unanalyzed.length > 0 && !this._aborted) {
                    const {id} = unanalyzed.shift();
                    this.progress.currentGameId = id;
                    await this.analyzeGame(id, pair.teacher, pair.student);
                    this.progress.done++;
                }
            };

            await Promise.all(engines.map(processQueue));
        } finally {
            this.progress.currentGameId = null;
            this._running = false;
        }
    }

    async analyzeGame(gameId, providedEngine = null, providedStudent = null) {
        // Fallback to reserving a temporary one if none provided, though analyzeAll passes it
        let engine = providedEngine;
        let student = providedStudent;
        let isTempEngine = false;
        let isTempStudent = false;

        if (!engine) {
            engine = this._manager.reserveEngine(`analysis-single`, this.stockfishPath);
            await engine.start();
            isTempEngine = true;
        }

        if (!student && this.studentPath) {
            student = this._manager.reserveEngine(`student-single`, this.studentPath);
            await student.start();
            isTempStudent = true;
        }

        const moves = await this._dbClient.getGameMoves(gameId);

        if (moves.length === 0) {
            if (isTempEngine) await this._manager.shutdownEngine(engine.label);
            return;
        }

        const evalOpts = this.moveTimeMs !== null
            ? {moveTime: this.moveTimeMs}
            : {depth: this.depth};

        // We evaluate N+1 positions for N plies.
        // posEvals[k] = Stockfish's evaluation of the position AFTER ply k
        //               (or the starting position for k=0).
        // scoreCp is always from the side-to-move's perspective.
        const posEvals = [];
        const studentEvals = [];

        await engine.uciNewGame();
        await engine.position("startpos");
        if (student) {
            await student.uciNewGame();
            await student.position("startpos");
        }

        if (student) {
            const [tEval, sEval] = await Promise.all([
                engine.goWithEval(evalOpts),
                student.goWithEval(evalOpts)
            ]);
            posEvals.push(tEval);
            studentEvals.push(sEval);
        } else {
            posEvals.push(await engine.goWithEval(evalOpts));
        }

        for (const move of moves) {
            if (this._aborted) return;
            if (!move.fenAfter) break; // chain requires FEN; stop here
            
            await engine.position(move.fenAfter);
            if (student) await student.position(move.fenAfter);

            if (student) {
                const [tEval, sEval] = await Promise.all([
                    engine.goWithEval(evalOpts),
                    student.goWithEval(evalOpts)
                ]);
                posEvals.push(tEval);
                studentEvals.push(sEval);
            } else {
                posEvals.push(await engine.goWithEval(evalOpts));
            }
        }

        // Build eval rows for each ply that has a complete (before, after) pair.
        const rows = [];
        const pairs = posEvals.length - 1;

        for (let i = 0; i < pairs && i < moves.length; i++) {
            const before = posEvals[i];
            const after = posEvals[i + 1];

            const studentBefore = studentEvals.length > i ? studentEvals[i] : null;

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
                ply: moves[i].ply,
                bestUci: before.bestMove ?? null,
                bestCp,
                playedCp,
                cpLoss,
                isMate: before.isMate ? 1 : 0,
                classification: classifyMove(cpLoss),
                studentCp: studentBefore ? studentBefore.scoreCp : null,
                studentUci: studentBefore ? studentBefore.bestMove : null
            });
        }

        if (rows.length > 0) {
            await this._dbClient.insertMoveEvals(gameId, rows);
        }

        if (isTempEngine) {
            await this._manager.shutdownEngine(engine.label);
        }
        if (isTempStudent && student) {
            await this._manager.shutdownEngine(student.label);
        }
    }

    async getStats() {
        return await this._dbClient.getStats();
    }
}
