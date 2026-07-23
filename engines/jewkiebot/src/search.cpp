#include "search.h"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <mutex>

namespace {

const int pieceValueForOrdering[] = {100, 320, 330, 500, 900, 20000};

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

// Log-based late-move-reduction table indexed by [depth][moveNumber].
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

} // namespace

Search::Search(const Evaluator& evaluator, TranspositionTable& tt)
    : evaluator_(evaluator), tt_(tt),
      numThreads_(std::max(1u, std::thread::hardware_concurrency())) {
    initLmrTable();
}

void Search::setThreadCount(int count) {
    numThreads_ = std::max(1, count);
}

bool Search::checkStopPeriodic(WorkerState& ws) {
    ws.nodes.store(ws.stats.totalNodes, std::memory_order_relaxed);
    if (stopFlag_.load(std::memory_order_relaxed)) return true;
    if (tm_.isHardTimeUp()) {
        stopFlag_.store(true, std::memory_order_relaxed);
        return true;
    }
    return false;
}

long long Search::totalNodesLive() const {
    if (!activeWorkers_) return aggregateStats_.totalNodes;
    long long total = 0;
    for (const auto& ws : *activeWorkers_) {
        total += ws.nodes.load(std::memory_order_relaxed);
    }
    return total;
}

void Search::printInfoScore(int score) const {
    if (score > MATE_BOUND) {
        std::cout << " score mate " << (MATE_SCORE - score + 1) / 2;
    } else if (score < -MATE_BOUND) {
        std::cout << " score mate -" << (score + MATE_SCORE + 1) / 2;
    } else {
        std::cout << " score cp " << score;
    }
}

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

        if (board.isRepetitionDraw()) break;
    }

    while (made-- > 0) board.unmakeMove();
    return pv;
}

Move Search::findBestMove(Board& board, int maxDepth, int timeLeftMs, int incrementMs, int movesToGo, bool infinite) {
    aggregateStats_.reset();
    stopFlag_.store(false, std::memory_order_relaxed);

    if (infinite) {
        tm_.startInfinite();
    }
    else if (movesToGo == 1 && incrementMs == 0 && timeLeftMs > 0) {
        tm_.startFixed(static_cast<uint64_t>(timeLeftMs));
    }
    else if (timeLeftMs > 0) {
        tm_.start(timeLeftMs, incrementMs, movesToGo);
    }
    else {
        tm_.start(50000, 0, 0);
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

        // Aspiration window around the previous iteration's score; widen and
        // re-search on a fail until the score lands inside the window.
        int alpha = -SCORE_INF;
        int beta = SCORE_INF;
        int delta = 25;
        if (depth >= 5 && std::abs(prevScore) < MATE_BOUND) {
            alpha = prevScore - delta;
            beta = prevScore + delta;
        }

        int score = 0;
        while (true) {
            score = searchRoot(workers[0], board, rootMoves, depth, alpha, beta, bestMove, true);
            if (stopped()) break;

            if (score <= alpha) {
                alpha = std::max(score - delta, -SCORE_INF);
            }
            else if (score >= beta) {
                beta = std::min(score + delta, SCORE_INF);
            }
            else {
                break;
            }

            delta += delta / 2 + 10;
            if (delta > 1500) {
                alpha = -SCORE_INF;
                beta = SCORE_INF;
            }
        }

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

void Search::helperThreadMain(WorkerState& ws, Board board, int maxDepth, int threadId) {
    MoveList moves;
    board.generateLegalMoves(moves);
    if (moves.empty()) return;

    Move localBest = moves[0];

    // Stagger helper start depths so threads explore different parts of the
    // tree and seed the shared TT (lazy SMP).
    int startDepth = 1 + (threadId % 2);

    for (int depth = startDepth; depth <= maxDepth; ++depth) {
        if (stopped()) break;
        searchRoot(ws, board, moves, depth, -SCORE_INF, SCORE_INF, localBest, false);
    }

    ws.nodes.store(ws.stats.totalNodes, std::memory_order_relaxed);
}

int Search::searchRoot(WorkerState& ws, Board& board, MoveList& rootMoves, int depth,
                       int alpha, int beta, Move& bestMoveOut, bool report) {
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

        int score;
        if (movesSearched == 0) {
            score = -negamax(ws, board, depth - 1, -beta, -alpha, 1, true);
        }
        else {
            // Principal variation search: prove later moves worse with a
            // null window, re-search on an unexpected improvement.
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
            if (alpha >= beta) break;
        }
    }

    if (!stopped() && movesSearched > 0 && currentBest.isValid()) {
        bestMoveOut = currentBest;
    }

    return bestScore;
}

int Search::negamax(WorkerState& ws, Board& board, int depth, int alpha, int beta,
                    int plyFromRoot, bool allowNull) {
    ws.stats.totalNodes++;

    if ((ws.stats.totalNodes & 2047) == 0 && checkStopPeriodic(ws)) return 0;

    // Path-dependent draws must be detected before the TT is consulted.
    if (board.isRepetitionDraw() || board.isFiftyMoveDraw()) {
        return 0;
    }

    if (plyFromRoot >= MAX_PLY) {
        return evaluator_.evaluate(board, board.sideToMove());
    }

    // Mate-distance pruning: never accept a mate longer than one already
    // proven, and never search for one slower than the current bound allows.
    alpha = std::max(alpha, -MATE_SCORE + plyFromRoot);
    beta = std::min(beta, MATE_SCORE - plyFromRoot - 1);
    if (alpha >= beta) return alpha;

    const bool pvNode = (beta - alpha) > 1;
    const bool inCheck = board.inCheck(board.sideToMove());

    // Check extension: never drop into quiescence while in check.
    if (inCheck) depth++;

    if (depth <= 0) {
        return quiescence(ws, board, alpha, beta, plyFromRoot);
    }

    const int oldAlpha = alpha;
    const uint64_t key = board.zobristKey();

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
    if (!pvNode && !inCheck && depth <= 6 && std::abs(beta) < MATE_BOUND &&
        staticEval - 80 * depth >= beta) {
        return staticEval;
    }

    // Null-move pruning. allowNull blocks two nulls in a row, which would
    // otherwise let one side "pass" twice and produce false cutoffs.
    if (allowNull && !pvNode && !inCheck && depth >= 3 && plyFromRoot > 0 &&
        beta < MATE_BOUND && staticEval >= beta) {
        bool hasBigPieces = board.occupancy(board.sideToMove()) & ~board.pieceBB(board.sideToMove(), Board::PAWN) & ~board.pieceBB(board.sideToMove(), Board::KING);

        if (hasBigPieces) {
            board.makeNullMove();

            int R = 3 + depth / 6;
            int score = -negamax(ws, board, depth - 1 - R, -beta, -beta + 1, plyFromRoot + 1, false);

            board.unmakeNullMove();

            if (stopped()) return 0;

            if (score >= beta) {
                // Don't return unproven mate scores from a null search.
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

    const bool futilityApplies = !pvNode && !inCheck && depth <= 3 &&
                                 staticEval + 120 * depth + 100 <= alpha;

    for (int i = 0; i < moves.size(); ++i) {
        pickBest(moves, scores, i);
        const Move& move = moves[i];

        const bool quiet = !move.isCapture() && move.type != MoveType::PROMOTION;

        // Quiet-move pruning, only once a real score backs it up so a node
        // where everything is pruned still detects mate/stalemate correctly.
        if (quiet && movesSearched > 0 && bestScore > -MATE_BOUND) {
            if (futilityApplies) continue;
            if (!pvNode && depth <= 4 && movesSearched >= 3 + depth * depth) continue;
        }

        if (!board.makeMove(move)) {
            continue;
        }

        int score;

        if (movesSearched == 0) {
            score = -negamax(ws, board, depth - 1, -beta, -alpha, plyFromRoot + 1, true);
        }
        else {
            const bool isKiller = quiet && (sameMove(move, ws.killers[plyFromRoot][0]) ||
                                            sameMove(move, ws.killers[plyFromRoot][1]));

            int reduction = 0;
            if (depth >= 3 && movesSearched >= 2 && quiet && !isKiller &&
                !board.inCheck(board.sideToMove())) {
                reduction = lmrTable[std::min(depth, 63)][std::min(movesSearched, 63)];
                if (pvNode && reduction > 0) reduction--;
                reduction = std::clamp(reduction, 0, depth - 2);
            }

            score = -negamax(ws, board, depth - 1 - reduction, -alpha - 1, -alpha, plyFromRoot + 1, true);

            if (score > alpha && reduction > 0) {
                score = -negamax(ws, board, depth - 1, -alpha - 1, -alpha, plyFromRoot + 1, true);
            }

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
                ws.stats.betaCutoffs++;
                if (movesSearched == 1) ws.stats.firstMoveCutoffs++;

                if (quiet) {
                    if (!sameMove(move, ws.killers[plyFromRoot][0])) {
                        ws.killers[plyFromRoot][1] = ws.killers[plyFromRoot][0];
                        ws.killers[plyFromRoot][0] = move;
                    }

                    int side = static_cast<int>(board.sideToMove());
                    ws.history[side][move.start][move.end] += depth * depth;

                    if (ws.history[side][move.start][move.end] > 10000000) {
                        ws.history[side][move.start][move.end] /= 2;
                    }
                }

                tt_.store(key, valueToTT(bestScore, plyFromRoot), depth, move, TranspositionTable::LOWERBOUND);
                return bestScore;
            }
        }
    }

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

int Search::quiescence(WorkerState& ws, Board& board, int alpha, int beta, int plyFromRoot) {
    ws.stats.totalNodes++;
    ws.stats.qNodes++;

    if ((ws.stats.totalNodes & 2047) == 0 && checkStopPeriodic(ws)) return 0;

    if (plyFromRoot > ws.stats.selDepth) ws.stats.selDepth = plyFromRoot;

    if (plyFromRoot >= MAX_PLY) {
        return evaluator_.evaluate(board, board.sideToMove());
    }

    const bool inCheck = board.inCheck(board.sideToMove());

    int bestScore;
    int standPat = 0;

    if (inCheck) {
        // Standing pat is illegal in check: every evasion must be searched.
        bestScore = -SCORE_INF;
    }
    else {
        standPat = evaluator_.evaluate(board, board.sideToMove());
        bestScore = standPat;
        if (bestScore >= beta) return bestScore;
        if (bestScore > alpha) alpha = bestScore;
    }

    MoveList moves;
    if (inCheck) {
        // Search every evasion.
        board.generatePseudoMoves(moves);
    }
    else {
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
                gain += pieceValueForOrdering[victim];
            }
            if (move.type == MoveType::PROMOTION) {
                Board::PieceIndex victim = board.getPieceAt(move.end);
                if (victim != Board::PieceTypeCount) gain += pieceValueForOrdering[victim];
                gain += pieceValueForOrdering[Board::QUEEN] - pieceValueForOrdering[Board::PAWN];
            }
            if (standPat + gain + 200 <= alpha) continue;
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

    if (inCheck && movesSearched == 0) {
        return -MATE_SCORE + plyFromRoot;
    }

    return bestScore;
}

void Search::scoreMoves(const WorkerState& ws, const Board& board, const MoveList& moves,
                        const Move& ttMove, int plyFromRoot, int* scores) const {
    const int side = static_cast<int>(board.sideToMove());
    const bool haveTTMove = ttMove.isValid() && ttMove.start != ttMove.end;

    for (int i = 0; i < moves.size(); ++i) {
        const Move& m = moves[i];

        if (haveTTMove && sameMove(m, ttMove)) {
            scores[i] = 2000000;
        }
        else if (m.isCapture()) {
            scores[i] = 1000000 + getMvvLvaScore(board, m);
        }
        else if (m.type == MoveType::PROMOTION) {
            scores[i] = 900000 + (m.promo == 'Q' ? 100 : 0);
        }
        else if (sameMove(m, ws.killers[plyFromRoot][0])) {
            scores[i] = 800000;
        }
        else if (sameMove(m, ws.killers[plyFromRoot][1])) {
            scores[i] = 799000;
        }
        else {
            scores[i] = ws.history[side][m.start][m.end];
        }
    }
}
