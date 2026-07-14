#include "search.h"
#include <algorithm>
#include <iostream>
#include <limits>
#include <cstring>

static constexpr int INF = 1000000;
static constexpr int MATE_SCORE = 100000;

static int getMvvLvaScore(const Board& board, const Move& move) {
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

Search::Search(const Evaluator& evaluator, TranspositionTable& tt): evaluator_(evaluator), tt_(tt), numThreads_(std::max(1u, std::thread::hardware_concurrency())) {}

void Search::setThreadCount(int count) {
    numThreads_ = std::max(1, count);
}

bool Search::shouldStop() const {
    return stopFlag_.load(std::memory_order_relaxed) || tm_.isHardTimeUp();
}

Move Search::findBestMove(Board& board, int maxDepth, int timeLeftMs, int incrementMs, int movesToGo, bool infinite) {
    aggregateStats_.reset();
    stopFlag_.store(false, std::memory_order_relaxed);

    if (infinite) {
        tm_.startInfinite();
    } else if (movesToGo == 1 && incrementMs == 0 && timeLeftMs > 0) {
        tm_.startFixed(static_cast<uint64_t>(timeLeftMs));
    } else if (timeLeftMs > 0) {
        tm_.start(timeLeftMs, incrementMs, movesToGo);
    } else {
        tm_.start(50000, 0, 0);
    }

    MoveList rootMoves;
    board.generateLegalMoves(rootMoves);

    if (rootMoves.empty()) {
        return {};
    }

    Move bestMove = rootMoves[0];
    Move prevBestMove{};
    bool hasPrevBest = false;
    int prevScore = 0;

    std::vector<WorkerState> workers(numThreads_);

    for (auto& worker : workers) worker.reset();

    std::vector<std::thread> helpers;

    helpers.reserve(numThreads_ - 1);

    for (int i = 1; i < numThreads_; ++i) {
        helpers.emplace_back(&Search::helperThreadMain, this, std::ref(workers[i]), Board(board), maxDepth, i);
    }

    for (int depth = 1; depth <= maxDepth; ++depth) {
        if (shouldStop()) break;
        if (depth > 1 && tm_.isSoftTimeUp()) break;

        int alpha = -INF;
        int beta = INF;

        orderMoves(workers[0], board, rootMoves, bestMove, 0);

        Move currentBestMove = rootMoves[0];
        int currentBestScore = -INF;

        int move_number = 1;
        for (const auto& move : rootMoves) {
            board.makeMove(move);

            auto now = std::chrono::steady_clock::now();
            auto timeMs = std::chrono::duration_cast<std::chrono::milliseconds>(now - tm_.getStartTime()).count();

            if (depth >= 4 && timeMs > 500) {
                long long currentTotalNodes = 0;

                for (const auto& worker : workers) {
                    currentTotalNodes += worker.stats.totalNodes;
                }

                long long nps = timeMs > 0 ? (currentTotalNodes * 1000) / timeMs : 0;

                std::cout << "info depth " << depth << " currmove " << move.toString() << " currmovenumber " << move_number;

                int displayScore = (currentBestScore != -INF) ? currentBestScore : prevScore;

                if (displayScore > MATE_SCORE - 1000) {
                    std::cout << " score mate " << (MATE_SCORE - displayScore + 1) / 2;
                } else if (displayScore < -MATE_SCORE + 1000) {
                    std::cout << " score mate -" << (displayScore + MATE_SCORE + 1) / 2;
                } else {
                    std::cout << " score cp " << displayScore;
                }

                std::cout << " nodes " << currentTotalNodes << " nps " << nps << " time " << timeMs << "\n";

                std::cout.flush();
            }

            int score = -negamax(workers[0], board, depth - 1, -beta, -alpha, 1);

            board.unmakeMove();

            if (shouldStop()) break;

            if (score > currentBestScore) {
                currentBestScore = score;
                currentBestMove = move;
            }

            if (score > alpha) {
                alpha = score;
            }

            ++move_number;
        }

        if (!shouldStop()) {
            bestMove = currentBestMove;
            const bool changed = hasPrevBest && !(bestMove == prevBestMove);
            tm_.onIterationComplete(changed);
            prevBestMove = bestMove;
            hasPrevBest = true;
            prevScore = currentBestScore;

            long long finalTotalNodes = 0;
            for (const auto& worker : workers) {
                finalTotalNodes += worker.stats.totalNodes;
            }
            auto timeMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - tm_.getStartTime()).count();
            long long nps = timeMs > 0 ? (finalTotalNodes * 1000) / timeMs : 0;

            // Output UCI info string for continuous scoring
            std::cout << "info depth " << depth;
            
            if (currentBestScore > MATE_SCORE - 1000) {
                std::cout << " score mate " << (MATE_SCORE - currentBestScore + 1) / 2;
            } else if (currentBestScore < -MATE_SCORE + 1000) {
                std::cout << " score mate -" << (currentBestScore + MATE_SCORE + 1) / 2;
            } else {
                std::cout << " score cp " << currentBestScore;
            }
            
            std::cout << " pv " << bestMove.toString() << " nodes " << finalTotalNodes << " nps " << nps << " time " << timeMs << "\n";

            std::cout.flush();
        }
    }

    stopFlag_.store(true, std::memory_order_relaxed);

    for (auto& t : helpers) t.join();

    for (const auto& worker : workers) {
        aggregateStats_ += worker.stats;
    }

    return bestMove;
}

void Search::helperThreadMain(WorkerState& worker, Board board, int maxDepth, int threadId) {
    MoveList moves;
    board.generateLegalMoves(moves);
    if (moves.empty()) return;

    Move localBest;
    bool foundAnyLegal = false;

    int startDepth = 1 + (threadId % 2);

    for (int depth = startDepth; depth <= maxDepth; ++depth) {
        if (shouldStop()) break;

        int alpha = -INF;
        int beta = INF;

        orderMoves(worker, board, moves, localBest, 0);

        Move currentBest;
        int currentBestScore = -INF;
        bool foundLegalMove = false;

        for (const auto& move : moves) {
            if (!board.makeMove(move)) {
                continue;
            }

            if (!foundLegalMove) {
                currentBest = move;
                foundLegalMove = true;

                if (!foundAnyLegal) {
                    localBest = move;
                    foundAnyLegal = true;
                }
            }

            int score = -negamax(worker, board, depth - 1, -beta, -alpha, 1);
            board.unmakeMove();

            if (shouldStop()) break;

            if (score > currentBestScore) {
                currentBestScore = score;
                currentBest = move;
            }

            if (score > alpha) {
                alpha = score;
            }
        }

        if (!shouldStop() && foundLegalMove) {
            localBest = currentBest;
        }
    }
}

int Search::negamax(WorkerState& worker, Board& board, int depth, int alpha, int beta, int plyFromRoot) {
    worker.stats.totalNodes++;

    int oldAlpha = alpha;

    if ((worker.stats.totalNodes & 2047) == 0 && shouldStop()) return 0;

    if (plyFromRoot > 0 && (board.isThreefoldRepetition() || board.isFiftyMoveDraw())) {
        return 0;
    }

    uint64_t key = board.zobristKey();
    TranspositionTable::TTEntry ent;
    Move ttMove = Move();

    if (tt_.probe(key, ent)) {
        ttMove = ent.bestMove;
        worker.stats.ttProbes++;

        if (ent.depth >= depth) {
            worker.stats.ttHits++;
            if (ent.flag == TranspositionTable::EXACT) return ent.value;
            if (ent.flag == TranspositionTable::LOWERBOUND) alpha = std::max(alpha, ent.value);
            if (ent.flag == TranspositionTable::UPPERBOUND) beta = std::min(beta, ent.value);
            if (alpha >= beta) return ent.value;
        }
    }

    if (depth == 0) {
        return quiescence(worker, board, alpha, beta, plyFromRoot);
    }

    if (depth >= 3 && !board.inCheck(board.sideToMove()) && plyFromRoot > 0 && beta < MATE_SCORE) {
        bool hasBigPieces = board.occupancy(board.sideToMove()) & ~board.pieceBB(board.sideToMove(), Board::PAWN);

        if (hasBigPieces) {
            board.makeNullMove();

            int R = 2;

            int score = -negamax(worker, board, depth - 1 - R, -beta, -beta + 1, plyFromRoot + 1);

            board.unmakeNullMove();

            if (shouldStop()) return 0;

            if (score >= beta) {
                return beta;
            }
        }
    }

    MoveList moves;
    board.generatePseudoMoves(moves);

    orderMoves(worker, board, moves.begin(), moves.size(), ttMove, plyFromRoot);

    int bestScore = -INF;
    Move bestMoveInNode;
    int movesSearched = 0;

    for (const auto& move : moves) {
        if (!board.makeMove(move)) {
            continue;
        }

        int score;

        if (movesSearched == 0) {
            score = -negamax(worker, board, depth - 1, -beta, -alpha, plyFromRoot + 1);
        }
        else {
            int reduction = 0;
            if (depth >= 3 && movesSearched >= 4 && !move.isCapture() && !board.inCheck(board.sideToMove())) {
                reduction = 2;
                if (depth - 1 - reduction <= 0) reduction = depth - 2;
            }

            score = -negamax(worker, board, depth - 1 - reduction, -alpha - 1, -alpha, plyFromRoot + 1);

            if (score > alpha && reduction > 0) {
                score = -negamax(worker, board, depth - 1, -alpha - 1, -alpha, plyFromRoot + 1);
            }

            if (score > alpha && score < beta) {
                score = -negamax(worker, board, depth - 1, -beta, -alpha, plyFromRoot + 1);
            }
        }

        board.unmakeMove();

        if (shouldStop()) return 0;

        if (score > bestScore) {
            bestScore = score;
            bestMoveInNode = move;
        }

        if (score > alpha) {
            alpha = score;

            if (alpha >= beta) {
                worker.stats.betaCutoffs++;
                if (movesSearched == 0) worker.stats.firstMoveCutoffs++;

                if (!move.isCapture()) {
                    int side = static_cast<int>(board.sideToMove());
                    worker.history[side][move.start][move.end] += depth * depth;

                    if (worker.history[side][move.start][move.end] > 10000000) {
                        worker.history[side][move.start][move.end] /= 2;
                    }

                    if (plyFromRoot < MAX_PLY && !(move == worker.killers[plyFromRoot][0])) {
                        worker.killers[plyFromRoot][1] = worker.killers[plyFromRoot][0];
                        worker.killers[plyFromRoot][0] = move;
                    }
                }

                tt_.store(key, beta, depth, move, TranspositionTable::LOWERBOUND);
                return beta;
            }
        }
        movesSearched++;
    }

    if (movesSearched == 0) {
        if (board.inCheck(board.sideToMove())) {
            return -MATE_SCORE + plyFromRoot;
        }
        else {
            return 0;
        }
    }

    int flag = TranspositionTable::EXACT;
    if (bestScore <= oldAlpha) {
        flag = TranspositionTable::UPPERBOUND;
    }
    else if (bestScore >= beta) {
        flag = TranspositionTable::LOWERBOUND;
    }

    tt_.store(key, bestScore, depth, bestMoveInNode, flag);

    return bestScore;
}

int Search::quiescence(WorkerState& worker, Board& board, int alpha, int beta, int plyFromRoot) {
    worker.stats.totalNodes++;
    worker.stats.qNodes++;

    if (plyFromRoot > 64) {
        return evaluator_.evaluate(board, board.sideToMove());
    }

    int standPat = evaluator_.evaluate(board, board.sideToMove());
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    MoveList captures;
    board.generatePseudoMoves(captures);

    // Compact captures/promotions in place; quiets are dropped.
    int keptCount = 0;
    for (int readIndex = 0; readIndex < captures.size(); ++readIndex) {
        const Move& candidateMove = captures[readIndex];
        if (candidateMove.isCapture() || candidateMove.type == MoveType::PROMOTION) {
            captures.moves[keptCount++] = candidateMove;
        }
    }
    captures.count = keptCount;

    orderMoves(worker, board, captures.begin(), captures.size(), Move(), plyFromRoot);

    // Delta pruning: material values for the best case a capture can gain.
    static constexpr int pieceValues[] = {100, 320, 330, 500, 900, 20000};
    constexpr int deltaMargin = 200;

    for (const auto& move : captures) {
        // Skip captures whose best-case material swing still can't lift the
        // stand-pat score to alpha.
        int bestCaseGain = 0;
        if (move.isCapture()) {
            Board::PieceIndex victimPiece = board.getPieceAt(move.end);
            bestCaseGain = (victimPiece < Board::PieceTypeCount) ? pieceValues[victimPiece]
                                                                 : pieceValues[Board::PAWN];  // en passant
        }
        if (move.type == MoveType::PROMOTION) {
            bestCaseGain += pieceValues[Board::QUEEN] - pieceValues[Board::PAWN];
        }
        if (standPat + bestCaseGain + deltaMargin <= alpha) {
            continue;
        }

        if (!board.makeMove(move)) {
            continue;
        }

        int score = -quiescence(worker, board, -beta, -alpha, plyFromRoot + 1);

        board.unmakeMove();

        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }
    return alpha;
}

void Search::orderMoves(const WorkerState& worker, const Board& board, Move* moves, int count, const Move& ttMove, int ply) {
    // Score each move once, then stable insertion sort descending. The old
    // stable_sort comparator recomputed both scores on every comparison.
    int moveScores[MAX_MOVES];
    const int sideToMoveIndex = static_cast<int>(board.sideToMove());
    const bool haveTtMove = (ttMove.start != ttMove.end);
    const Move* killerMoves = (ply < MAX_PLY) ? worker.killers[ply] : nullptr;

    for (int moveIndex = 0; moveIndex < count; ++moveIndex) {
        const Move& move = moves[moveIndex];
        int score = 0;

        if (haveTtMove && move.start == ttMove.start && move.end == ttMove.end) score += 2000000;

        if (move.isCapture()) {
            score += getMvvLvaScore(board, move) + 100000;
        } else {
            // Killer bonus sits just below captures, above ordinary history.
            if (killerMoves) {
                if (move == killerMoves[0]) score += 95000;
                else if (move == killerMoves[1]) score += 94000;
            }
            score += worker.history[sideToMoveIndex][move.start][move.end];
        }

        if (move.type == MoveType::PROMOTION) score += 90000;

        moveScores[moveIndex] = score;
    }

    for (int sortIndex = 1; sortIndex < count; ++sortIndex) {
        Move currentMove = moves[sortIndex];
        int currentScore = moveScores[sortIndex];
        int scanIndex = sortIndex - 1;
        while (scanIndex >= 0 && moveScores[scanIndex] < currentScore) {
            moves[scanIndex + 1] = moves[scanIndex];
            moveScores[scanIndex + 1] = moveScores[scanIndex];
            --scanIndex;
        }
        moves[scanIndex + 1] = currentMove;
        moveScores[scanIndex + 1] = currentScore;
    }
}

void Search::orderMoves(const WorkerState& worker, const Board& board, MoveList& moves, const Move& ttMove, int ply) {
    orderMoves(worker, board, moves.begin(), moves.size(), ttMove, ply);
}