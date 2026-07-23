#include "search.h"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <mutex>

// ---------------------------------------------------------------------------
// Tunable search parameters. All margins are in centipawns; depths in plies.
// ---------------------------------------------------------------------------
namespace {

// Move ordering: every move gets a score, and moves are searched from the
// highest score down. Each tier sits far above the one below it, and quiet
// moves fall through to their history score (always below every tier).
constexpr int ORDER_TT_MOVE = 2000000;       // best move from the hash table
constexpr int ORDER_CAPTURE_BASE = 1000000;  // + MVV-LVA score
constexpr int ORDER_PROMOTION = 900000;      // + small bonus for queening
constexpr int ORDER_FIRST_KILLER = 800000;
constexpr int ORDER_SECOND_KILLER = 799000;

// Reverse futility pruning: fail high immediately when the static eval is
// this far above beta at shallow depth.
constexpr int RFP_MAX_DEPTH = 6;
constexpr int RFP_MARGIN_PER_PLY = 80;

// Futility pruning: at shallow depth, skip quiet moves when the static eval
// plus this margin still can't reach alpha.
constexpr int FUTILITY_MAX_DEPTH = 3;
constexpr int FUTILITY_MARGIN_BASE = 100;
constexpr int FUTILITY_MARGIN_PER_PLY = 120;

// Late move pruning: at shallow depth, stop trying quiet moves after
// LMP_MOVE_LIMIT(depth) of them have already been searched.
constexpr int LMP_MAX_DEPTH = 4;
constexpr int lmpMoveLimit(int depth) { return 3 + depth * depth; }

// Null-move pruning: skip a turn and search reduced; a fail-high means the
// position is so good the opponent couldn't catch up even with a free move.
constexpr int NULL_MOVE_MIN_DEPTH = 3;
constexpr int nullMoveReduction(int depth) { return 3 + depth / 6; }

// Late move reductions: moves ordered late are searched at reduced depth
// first and only re-searched at full depth if they surprise us.
constexpr int LMR_MIN_DEPTH = 3;
constexpr int LMR_MIN_MOVES_SEARCHED = 2;

// Quiescence delta pruning: skip a capture when even winning the victim
// plus this margin can't lift the score back to alpha.
constexpr int DELTA_PRUNING_MARGIN = 200;

// Aspiration windows: from this depth on, open the root search in a narrow
// window around the previous score and widen only on a fail.
constexpr int ASPIRATION_MIN_DEPTH = 5;
constexpr int ASPIRATION_INITIAL_WINDOW = 25;
constexpr int ASPIRATION_MAX_WINDOW = 1500;

// History scores are halved when they grow past this, keeping them bounded
// while preserving their relative order.
constexpr int HISTORY_SCORE_LIMIT = 10000000;

// The wall clock is only consulted once per this many nodes (must be a
// power of two; used as a bitmask).
constexpr long long STOP_CHECK_INTERVAL = 2048;

const int PIECE_VALUES[] = {100, 320, 330, 500, 900, 20000};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Mate scores are stored in the TT relative to the node that found them, so
// an entry found at one ply can be reused at another without corrupting the
// distance-to-mate. Convert on the way in and out.
int valueToTT(int value, int plyFromRoot) {
    if (value >= MATE_BOUND) return value + plyFromRoot;
    if (value <= -MATE_BOUND) return value - plyFromRoot;
    return value;
}

int valueFromTT(int value, int plyFromRoot) {
    if (value >= MATE_BOUND) return value - plyFromRoot;
    if (value <= -MATE_BOUND) return value + plyFromRoot;
    return value;
}

// Most Valuable Victim / Least Valuable Attacker: prefer taking big pieces
// with small ones (PxQ first, QxP last among captures).
int getMvvLvaScore(const Board& board, const Move& move) {
    if (!move.isCapture()) return 0;

    Board::PieceIndex victim = board.getPieceAt(move.end);
    Board::PieceIndex attacker = board.getPieceAt(move.start);

    if (victim == Board::PieceTypeCount) {
        if (move.type == MoveType::EN_PASSANT) victim = Board::PAWN;
        else return 0;
    }

    static const int victimScores[] = {100, 200, 300, 400, 500, 600};
    int vScore = (victim < 6) ? victimScores[victim] : 0;

    static const int attackerScores[] = {1, 2, 3, 4, 5, 6};
    int aScore = (attacker < 6) ? attackerScores[attacker] : 0;

    return vScore - aScore;
}

// Precomputed LMR table: reduce deeper and for later moves, on a log curve.
int lmrTable[64][64];
std::once_flag lmrOnceFlag;

void initLmrTable() {
    std::call_once(lmrOnceFlag, []() {
        for (int depth = 1; depth < 64; ++depth) {
            for (int moveNumber = 1; moveNumber < 64; ++moveNumber) {
                lmrTable[depth][moveNumber] = static_cast<int>(
                    0.75 + std::log(depth) * std::log(moveNumber) / 2.25);
            }
        }
    });
}

// Swap the highest-scored remaining move into position `index`. Most nodes
// cut off after one or two moves, so lazy selection beats sorting the list.
void pickBest(MoveList& moves, int* scores, int index) {
    int bestIndex = index;
    for (int j = index + 1; j < moves.size(); ++j) {
        if (scores[j] > scores[bestIndex]) bestIndex = j;
    }
    if (bestIndex != index) {
        std::swap(moves[index], moves[bestIndex]);
        std::swap(scores[index], scores[bestIndex]);
    }
}

bool sameMove(const Move& a, const Move& b) {
    return a.start == b.start && a.end == b.end && a.promo == b.promo;
}

bool isQuiet(const Move& move) {
    return !move.isCapture() && move.type != MoveType::PROMOTION;
}

} // namespace

// ---------------------------------------------------------------------------
// Setup and shared plumbing
// ---------------------------------------------------------------------------

Search::Search(const Evaluator& evaluator, TranspositionTable& tt)
    : evaluator_(evaluator), tt_(tt),
      numThreads_(std::max(1u, std::thread::hardware_concurrency())) {
    initLmrTable();
}

void Search::setThreadCount(int count) {
    numThreads_ = std::max(1, count);
}

// Periodic stop check (called once per STOP_CHECK_INTERVAL nodes): publishes
// this worker's node count for live info lines, and latches the stop flag
// when the hard deadline passes so every thread stops together. The per-move
// check in the hot loops is just the cheap relaxed load in stopped().
bool Search::checkStopPeriodic(WorkerState& ws) {
    ws.nodes.store(ws.stats.totalNodes, std::memory_order_relaxed);
    if (stopFlag_.load(std::memory_order_relaxed)) return true;
    if (tm_.isHardTimeUp()) {
        stopFlag_.store(true, std::memory_order_relaxed);
        return true;
    }
    return false;
}

// Sum of all workers' published node counts; safe to call while they search.
long long Search::totalNodesLive() const {
    if (!activeWorkers_) return aggregateStats_.totalNodes;
    long long total = 0;
    for (const auto& ws : *activeWorkers_) {
        total += ws.nodes.load(std::memory_order_relaxed);
    }
    return total;
}

// " score cp X" or " score mate N" for a UCI info line.
void Search::printInfoScore(int score) const {
    if (score > MATE_BOUND) {
        std::cout << " score mate " << (MATE_SCORE - score + 1) / 2;
    } else if (score < -MATE_BOUND) {
        std::cout << " score mate -" << (score + MATE_SCORE + 1) / 2;
    } else {
        std::cout << " score cp " << score;
    }
}

// Build a principal variation string by playing the best move and then
// following the TT's best-move chain, verifying each move is legal as we go.
std::string Search::pvString(Board& board, const Move& first, int maxLen) const {
    std::string pv = first.toString();

    if (!board.makeMove(first)) return pv;
    int made = 1;

    for (int i = 1; i < maxLen && made < MAX_PLY; ++i) {
        TranspositionTable::TTEntry ent;
        if (!tt_.probe(board.zobristKey(), ent)) break;

        Move move = ent.bestMove;
        if (!move.isValid() || move.start == move.end) break;
        if (!board.makeMove(move)) break;

        ++made;
        pv += ' ';
        pv += move.toString();

        if (board.isRepetitionDraw()) break; // don't loop forever on a shuffle
    }

    while (made-- > 0) board.unmakeMove();
    return pv;
}

// ---------------------------------------------------------------------------
// Iterative deepening driver
// ---------------------------------------------------------------------------

Move Search::findBestMove(Board& board, int maxDepth, int timeLeftMs, int incrementMs, int movesToGo, bool infinite) {
    aggregateStats_.reset();
    stopFlag_.store(false, std::memory_order_relaxed);

    // Pick a time budget for this move.
    if (infinite) {
        tm_.startInfinite();
    } else if (movesToGo == 1 && incrementMs == 0 && timeLeftMs > 0) {
        tm_.startFixed(static_cast<uint64_t>(timeLeftMs)); // "go movetime"
    } else if (timeLeftMs > 0) {
        tm_.start(timeLeftMs, incrementMs, movesToGo);
    } else {
        tm_.start(50000, 0, 0); // no clock given: assume a generous budget
    }

    MoveList rootMoves;
    board.generateLegalMoves(rootMoves);

    if (rootMoves.empty()) {
        return Move();
    }

    Move bestMove = rootMoves[0];
    Move prevBestMove;
    bool hasPrevBest = false;
    int prevScore = 0;

    // One worker per thread: worker 0 runs here, the rest are lazy-SMP
    // helpers that share only the transposition table.
    std::vector<WorkerState> workers(numThreads_);
    for (auto& ws : workers) ws.reset();
    activeWorkers_ = &workers;

    std::vector<std::thread> helpers;
    helpers.reserve(numThreads_ - 1);
    for (int i = 1; i < numThreads_; ++i) {
        helpers.emplace_back(&Search::helperThreadMain, this, std::ref(workers[i]), Board(board), maxDepth, i);
    }

    for (int depth = 1; depth <= maxDepth; ++depth) {
        if (stopped()) break;
        if (depth > 1 && tm_.isSoftTimeUp()) break;

        // Open in a narrow aspiration window around last iteration's score;
        // widen and re-search whenever the true score falls outside it.
        int alpha = -SCORE_INF;
        int beta = SCORE_INF;
        int window = ASPIRATION_INITIAL_WINDOW;
        if (depth >= ASPIRATION_MIN_DEPTH && std::abs(prevScore) < MATE_BOUND) {
            alpha = prevScore - window;
            beta = prevScore + window;
        }

        int score = 0;
        while (true) {
            score = searchRoot(workers[0], board, rootMoves, depth, alpha, beta, bestMove, true);
            if (stopped()) break;

            if (score <= alpha) {
                alpha = std::max(score - window, -SCORE_INF); // fail low: widen down
            } else if (score >= beta) {
                beta = std::min(score + window, SCORE_INF);   // fail high: widen up
            } else {
                break;                                        // inside the window
            }

            window += window / 2 + 10;
            if (window > ASPIRATION_MAX_WINDOW) {
                alpha = -SCORE_INF;
                beta = SCORE_INF;
            }
        }

        // Only completed iterations update state or get reported.
        if (!stopped()) {
            const bool changed = hasPrevBest && !sameMove(bestMove, prevBestMove);
            tm_.onIterationComplete(changed);
            prevBestMove = bestMove;
            hasPrevBest = true;
            prevScore = score;

            workers[0].nodes.store(workers[0].stats.totalNodes, std::memory_order_relaxed);
            long long nodes = totalNodesLive();
            auto timeMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - tm_.getStartTime()).count();
            long long nps = timeMs > 0 ? (nodes * 1000) / timeMs : 0;

            std::cout << "info depth " << depth
                      << " seldepth " << workers[0].stats.selDepth;
            printInfoScore(score);
            std::cout << " nodes " << nodes
                      << " nps " << nps
                      << " hashfull " << tt_.hashfull()
                      << " time " << timeMs
                      << " pv " << pvString(board, bestMove, depth) << "\n";
            std::cout.flush();
        }
    }

    stopFlag_.store(true, std::memory_order_relaxed);

    for (auto& t : helpers) t.join();

    for (const auto& ws : workers) {
        aggregateStats_ += ws.stats;
    }
    activeWorkers_ = nullptr;

    return bestMove;
}

// Lazy-SMP helper: same iterative deepening as the main thread but without
// reporting. Helpers contribute by filling the shared TT; staggered start
// depths push them into different parts of the tree.
void Search::helperThreadMain(WorkerState& ws, Board board, int maxDepth, int threadId) {
    MoveList moves;
    board.generateLegalMoves(moves);
    if (moves.empty()) return;

    Move localBest = moves[0];
    int startDepth = 1 + (threadId % 2);

    for (int depth = startDepth; depth <= maxDepth; ++depth) {
        if (stopped()) break;
        searchRoot(ws, board, moves, depth, -SCORE_INF, SCORE_INF, localBest, false);
    }

    ws.nodes.store(ws.stats.totalNodes, std::memory_order_relaxed);
}

// ---------------------------------------------------------------------------
// Root search: one pass over the root moves at a given depth
// ---------------------------------------------------------------------------

int Search::searchRoot(WorkerState& ws, Board& board, MoveList& rootMoves, int depth,
                       int alpha, int beta, Move& bestMoveOut, bool report) {
    // Order with the current best move first (it plays the TT-move role).
    int scores[MAX_MOVES];
    scoreMoves(ws, board, rootMoves, bestMoveOut, 0, scores);

    Move currentBest;
    int bestScore = -SCORE_INF;
    int movesSearched = 0;

    for (int i = 0; i < rootMoves.size(); ++i) {
        pickBest(rootMoves, scores, i);
        const Move& move = rootMoves[i];

        if (!board.makeMove(move)) {
            continue;
        }

        // Long think: tell the GUI which root move is being searched.
        if (report) {
            auto timeMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - tm_.getStartTime()).count();
            if (depth >= 4 && timeMs > 500) {
                std::cout << "info depth " << depth
                          << " currmove " << move.toString()
                          << " currmovenumber " << (movesSearched + 1)
                          << " nodes " << totalNodesLive()
                          << " time " << timeMs << "\n";
                std::cout.flush();
            }
        }

        // Principal variation search: the first move gets the full window;
        // later moves must first beat alpha in a null window before they
        // earn a full-window re-search.
        int score;
        if (movesSearched == 0) {
            score = -negamax(ws, board, depth - 1, -beta, -alpha, 1, true);
        } else {
            score = -negamax(ws, board, depth - 1, -alpha - 1, -alpha, 1, true);
            if (score > alpha && score < beta) {
                score = -negamax(ws, board, depth - 1, -beta, -alpha, 1, true);
            }
        }

        board.unmakeMove();

        if (stopped()) break;
        ++movesSearched;

        if (score > bestScore) {
            bestScore = score;
            currentBest = move;
        }

        if (score > alpha) {
            alpha = score;
            if (alpha >= beta) break; // aspiration fail-high; caller widens
        }
    }

    // Never publish a best move from an interrupted pass.
    if (!stopped() && movesSearched > 0 && currentBest.isValid()) {
        bestMoveOut = currentBest;
    }

    return bestScore;
}

// ---------------------------------------------------------------------------
// Main alpha-beta search (negamax form, fail-soft)
// ---------------------------------------------------------------------------

int Search::negamax(WorkerState& ws, Board& board, int depth, int alpha, int beta,
                    int plyFromRoot, bool allowNull) {
    ws.stats.totalNodes++;

    if ((ws.stats.totalNodes & (STOP_CHECK_INTERVAL - 1)) == 0 && checkStopPeriodic(ws)) return 0;

    // Draws by rule. These depend on the path taken, so they must be
    // detected before the (path-independent) TT is consulted.
    if (board.isRepetitionDraw() || board.isFiftyMoveDraw()) {
        return 0;
    }

    if (plyFromRoot >= MAX_PLY) {
        return evaluator_.evaluate(board, board.sideToMove());
    }

    // Mate-distance pruning: never accept a mate slower than one already
    // proven, and never hunt for one slower than the bounds allow.
    alpha = std::max(alpha, -MATE_SCORE + plyFromRoot);
    beta = std::min(beta, MATE_SCORE - plyFromRoot - 1);
    if (alpha >= beta) return alpha;

    const bool pvNode = (beta - alpha) > 1;
    const bool inCheck = board.inCheck(board.sideToMove());

    // Check extension: search evasions one ply deeper, and never drop into
    // quiescence while in check.
    if (inCheck) depth++;

    if (depth <= 0) {
        return quiescence(ws, board, alpha, beta, plyFromRoot);
    }

    const int oldAlpha = alpha;
    const uint64_t key = board.zobristKey();

    // Transposition table probe. At PV nodes the entry only seeds move
    // ordering; taking cutoffs there would truncate the reported PV.
    Move ttMove;
    ws.stats.ttProbes++;
    TranspositionTable::TTEntry ent;
    if (tt_.probe(key, ent)) {
        ws.stats.ttHits++;
        ttMove = ent.bestMove;

        if (!pvNode && ent.depth >= depth) {
            int ttValue = valueFromTT(ent.value, plyFromRoot);
            if (ent.flag == TranspositionTable::EXACT) return ttValue;
            if (ent.flag == TranspositionTable::LOWERBOUND) alpha = std::max(alpha, ttValue);
            if (ent.flag == TranspositionTable::UPPERBOUND) beta = std::min(beta, ttValue);
            if (alpha >= beta) return ttValue;
        }
    }

    const int staticEval = inCheck ? 0 : evaluator_.evaluate(board, board.sideToMove());

    // Reverse futility pruning: at shallow depth, a static eval comfortably
    // above beta almost always survives the remaining plies.
    if (!pvNode && !inCheck && depth <= RFP_MAX_DEPTH && std::abs(beta) < MATE_BOUND &&
        staticEval - RFP_MARGIN_PER_PLY * depth >= beta) {
        return staticEval;
    }

    // Null-move pruning. allowNull blocks two nulls in a row (one side
    // passing twice would search the same position at reduced depth and
    // produce false cutoffs). The big-piece check avoids zugzwang traps in
    // pawn endings, where passing can be the only losing "move".
    if (allowNull && !pvNode && !inCheck && depth >= NULL_MOVE_MIN_DEPTH && plyFromRoot > 0 &&
        beta < MATE_BOUND && staticEval >= beta) {
        bool hasBigPieces = board.occupancy(board.sideToMove()) & ~board.pieceBB(board.sideToMove(), Board::PAWN) & ~board.pieceBB(board.sideToMove(), Board::KING);

        if (hasBigPieces) {
            board.makeNullMove();
            int score = -negamax(ws, board, depth - 1 - nullMoveReduction(depth), -beta, -beta + 1, plyFromRoot + 1, false);
            board.unmakeNullMove();

            if (stopped()) return 0;

            if (score >= beta) {
                // A mate found on a skipped turn isn't proven; return beta.
                return (score >= MATE_BOUND) ? beta : score;
            }
        }
    }

    MoveList moves;
    board.generatePseudoMoves(moves);

    int scores[MAX_MOVES];
    scoreMoves(ws, board, moves, ttMove, plyFromRoot, scores);

    int bestScore = -SCORE_INF;
    Move bestMoveInNode;
    int movesSearched = 0;

    const bool futilityApplies = !pvNode && !inCheck && depth <= FUTILITY_MAX_DEPTH &&
                                 staticEval + FUTILITY_MARGIN_PER_PLY * depth + FUTILITY_MARGIN_BASE <= alpha;

    for (int i = 0; i < moves.size(); ++i) {
        pickBest(moves, scores, i);
        const Move& move = moves[i];
        const bool quiet = isQuiet(move);

        // Quiet-move pruning — but only once a real score backs it up, so a
        // node where everything gets pruned still detects mate/stalemate.
        if (quiet && movesSearched > 0 && bestScore > -MATE_BOUND) {
            if (futilityApplies) continue;
            if (!pvNode && depth <= LMP_MAX_DEPTH && movesSearched >= lmpMoveLimit(depth)) continue;
        }

        if (!board.makeMove(move)) {
            continue; // pseudo-legal move left our king in check
        }

        int score;

        if (movesSearched == 0) {
            // First move: full window.
            score = -negamax(ws, board, depth - 1, -beta, -alpha, plyFromRoot + 1, true);
        } else {
            // Later moves: possibly reduced, always null-window first.
            const bool isKiller = quiet && (sameMove(move, ws.killers[plyFromRoot][0]) ||
                                            sameMove(move, ws.killers[plyFromRoot][1]));

            int reduction = 0;
            // (board.inCheck after makeMove asks: does this move give check?)
            if (depth >= LMR_MIN_DEPTH && movesSearched >= LMR_MIN_MOVES_SEARCHED &&
                quiet && !isKiller && !board.inCheck(board.sideToMove())) {
                reduction = lmrTable[std::min(depth, 63)][std::min(movesSearched, 63)];
                if (pvNode && reduction > 0) reduction--; // trust PV nodes more
                reduction = std::clamp(reduction, 0, depth - 2);
            }

            score = -negamax(ws, board, depth - 1 - reduction, -alpha - 1, -alpha, plyFromRoot + 1, true);

            // Beat alpha at reduced depth? Verify at full depth.
            if (score > alpha && reduction > 0) {
                score = -negamax(ws, board, depth - 1, -alpha - 1, -alpha, plyFromRoot + 1, true);
            }

            // Beat alpha inside a PV window? Re-search with the full window.
            if (score > alpha && score < beta) {
                score = -negamax(ws, board, depth - 1, -beta, -alpha, plyFromRoot + 1, true);
            }
        }

        board.unmakeMove();

        if (stopped()) return 0;
        movesSearched++;

        if (score > bestScore) {
            bestScore = score;
            bestMoveInNode = move;
        }

        if (score > alpha) {
            alpha = score;

            if (alpha >= beta) {
                // Beta cutoff: remember what worked for future ordering.
                ws.stats.betaCutoffs++;
                if (movesSearched == 1) ws.stats.firstMoveCutoffs++;

                if (quiet) {
                    if (!sameMove(move, ws.killers[plyFromRoot][0])) {
                        ws.killers[plyFromRoot][1] = ws.killers[plyFromRoot][0];
                        ws.killers[plyFromRoot][0] = move;
                    }

                    int side = static_cast<int>(board.sideToMove());
                    ws.history[side][move.start][move.end] += depth * depth;

                    if (ws.history[side][move.start][move.end] > HISTORY_SCORE_LIMIT) {
                        ws.history[side][move.start][move.end] /= 2;
                    }
                }

                tt_.store(key, valueToTT(bestScore, plyFromRoot), depth, move, TranspositionTable::LOWERBOUND);
                return bestScore;
            }
        }
    }

    // No legal move: checkmate (worse the closer to the root) or stalemate.
    if (movesSearched == 0) {
        if (inCheck) {
            return -MATE_SCORE + plyFromRoot;
        }
        return 0;
    }

    int flag = (bestScore <= oldAlpha) ? TranspositionTable::UPPERBOUND
                                       : TranspositionTable::EXACT;
    tt_.store(key, valueToTT(bestScore, plyFromRoot), depth, bestMoveInNode, flag);

    return bestScore;
}

// ---------------------------------------------------------------------------
// Quiescence search: play out captures (or evasions while in check) so the
// evaluation is only ever taken in quiet positions.
// ---------------------------------------------------------------------------

int Search::quiescence(WorkerState& ws, Board& board, int alpha, int beta, int plyFromRoot) {
    ws.stats.totalNodes++;
    ws.stats.qNodes++;

    if ((ws.stats.totalNodes & (STOP_CHECK_INTERVAL - 1)) == 0 && checkStopPeriodic(ws)) return 0;

    if (plyFromRoot > ws.stats.selDepth) ws.stats.selDepth = plyFromRoot;

    if (plyFromRoot >= MAX_PLY) {
        return evaluator_.evaluate(board, board.sideToMove());
    }

    const bool inCheck = board.inCheck(board.sideToMove());

    // Stand pat: assume "do nothing" is worth the static eval — unless in
    // check, where doing nothing is illegal and every evasion must be tried.
    int bestScore;
    int standPat = 0;

    if (inCheck) {
        bestScore = -SCORE_INF;
    } else {
        standPat = evaluator_.evaluate(board, board.sideToMove());
        bestScore = standPat;
        if (bestScore >= beta) return bestScore;
        if (bestScore > alpha) alpha = bestScore;
    }

    MoveList moves;
    if (inCheck) {
        board.generatePseudoMoves(moves); // every evasion
    } else {
        MoveList allMoves;
        board.generatePseudoMoves(allMoves);
        for (const auto& m : allMoves) {
            if (m.isCapture() || m.type == MoveType::PROMOTION) {
                moves.push_back(m);
            }
        }
    }

    int scores[MAX_MOVES];
    scoreMoves(ws, board, moves, Move(), plyFromRoot, scores);

    int movesSearched = 0;

    for (int i = 0; i < moves.size(); ++i) {
        pickBest(moves, scores, i);
        const Move& move = moves[i];

        // Delta pruning: skip captures that can't lift the score back to
        // alpha even with a generous margin.
        if (!inCheck) {
            int gain = 0;
            if (move.isCapture()) {
                Board::PieceIndex victim = board.getPieceAt(move.end);
                if (victim == Board::PieceTypeCount) victim = Board::PAWN; // en passant
                gain += PIECE_VALUES[victim];
            }
            if (move.type == MoveType::PROMOTION) {
                Board::PieceIndex victim = board.getPieceAt(move.end);
                if (victim != Board::PieceTypeCount) gain += PIECE_VALUES[victim];
                gain += PIECE_VALUES[Board::QUEEN] - PIECE_VALUES[Board::PAWN];
            }
            if (standPat + gain + DELTA_PRUNING_MARGIN <= alpha) continue;
        }

        if (!board.makeMove(move)) {
            continue;
        }

        movesSearched++;
        int score = -quiescence(ws, board, -beta, -alpha, plyFromRoot + 1);

        board.unmakeMove();

        if (stopped()) return 0;

        if (score > bestScore) bestScore = score;
        if (score > alpha) {
            alpha = score;
            if (alpha >= beta) return bestScore;
        }
    }

    // In check with no legal reply is checkmate, even in quiescence.
    if (inCheck && movesSearched == 0) {
        return -MATE_SCORE + plyFromRoot;
    }

    return bestScore;
}

// ---------------------------------------------------------------------------
// Move ordering
// ---------------------------------------------------------------------------

void Search::scoreMoves(const WorkerState& ws, const Board& board, const MoveList& moves,
                        const Move& ttMove, int plyFromRoot, int* scores) const {
    const int side = static_cast<int>(board.sideToMove());
    const bool haveTTMove = ttMove.isValid() && ttMove.start != ttMove.end;

    for (int i = 0; i < moves.size(); ++i) {
        const Move& m = moves[i];

        if (haveTTMove && sameMove(m, ttMove)) {
            scores[i] = ORDER_TT_MOVE;
        } else if (m.isCapture()) {
            scores[i] = ORDER_CAPTURE_BASE + getMvvLvaScore(board, m);
        } else if (m.type == MoveType::PROMOTION) {
            scores[i] = ORDER_PROMOTION + (m.promo == 'Q' ? 100 : 0);
        } else if (sameMove(m, ws.killers[plyFromRoot][0])) {
            scores[i] = ORDER_FIRST_KILLER;
        } else if (sameMove(m, ws.killers[plyFromRoot][1])) {
            scores[i] = ORDER_SECOND_KILLER;
        } else {
            scores[i] = ws.history[side][m.start][m.end];
        }
    }
}
