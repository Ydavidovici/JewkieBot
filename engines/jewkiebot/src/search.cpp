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

Search::Search(const Evaluator& evaluator, TranspositionTable& tt)
    : evaluator_(evaluator), tt_(tt),
      numThreads_(std::max(1u, std::thread::hardware_concurrency())) {}

void Search::setThreadCount(int count) {
    numThreads_ = std::max(1, count);
}

bool Search::shouldStop() const {
    return stopFlag_.load(std::memory_order_relaxed) || tm_.isHardTimeUp();
}

Move Search::findBestMove(Board& board, int maxDepth, int timeLeftMs, int incrementMs, int movesToGo) {
    aggregateStats_.reset();
    stopFlag_.store(false, std::memory_order_relaxed);

    if (movesToGo == 1 && incrementMs == 0 && timeLeftMs > 0) {
        tm_.startFixed(static_cast<uint64_t>(timeLeftMs));
    }
    else if (timeLeftMs > 0) {
        tm_.start(timeLeftMs, incrementMs, movesToGo);
    }
    else {
        tm_.start(50000, 0, 0);
    }

    auto rootMoves = board.generateLegalMoves();

    if (rootMoves.empty()) {
        return Move();
    }

    Move bestMove = rootMoves[0];
    Move prevBestMove;
    bool hasPrevBest = false;

    std::vector<WorkerState> workers(numThreads_);
    for (auto& ws : workers) ws.reset();

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

        orderMoves(workers[0], board, rootMoves, bestMove);

        Move currentBestMove;
        int currentBestScore = -INF;
        bool foundLegalMove = false;

        for (const auto& move : rootMoves) {
            if (!board.makeMove(move)) {
                continue;
            }

            if (!foundLegalMove) {
                currentBestMove = move;
                foundLegalMove = true;
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
        }

        if (!shouldStop() && foundLegalMove) {
            bestMove = currentBestMove;
            const bool changed = hasPrevBest && !(bestMove == prevBestMove);
            tm_.onIterationComplete(changed);
            prevBestMove = bestMove;
            hasPrevBest = true;
        }
    }

    stopFlag_.store(true, std::memory_order_relaxed);

    for (auto& t : helpers) t.join();

    for (const auto& ws : workers) {
        aggregateStats_ += ws.stats;
    }

    return bestMove;
}

void Search::helperThreadMain(WorkerState& ws, Board board, int maxDepth, int threadId) {
    auto moves = board.generateLegalMoves();
    if (moves.empty()) return;

    Move localBest;
    bool foundAnyLegal = false;

    int startDepth = 1 + (threadId % 2);

    for (int depth = startDepth; depth <= maxDepth; ++depth) {
        if (shouldStop()) break;

        int alpha = -INF;
        int beta = INF;

        orderMoves(ws, board, moves, localBest);

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

            int score = -negamax(ws, board, depth - 1, -beta, -alpha, 1);
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

int Search::negamax(WorkerState& ws, Board& board, int depth, int alpha, int beta, int plyFromRoot) {
    ws.stats.totalNodes++;

    int oldAlpha = alpha;

    if ((ws.stats.totalNodes & 2047) == 0 && shouldStop()) return 0;

    if (plyFromRoot > 0 && (board.isThreefoldRepetition() || board.isFiftyMoveDraw())) {
        return 0;
    }

    uint64_t key = board.zobristKey();
    TranspositionTable::TTEntry ent;
    Move ttMove = Move();

    if (tt_.probe(key, ent)) {
        ttMove = ent.bestMove;
        ws.stats.ttProbes++;

        if (ent.depth >= depth) {
            ws.stats.ttHits++;
            if (ent.flag == TranspositionTable::EXACT) return ent.value;
            if (ent.flag == TranspositionTable::LOWERBOUND) alpha = std::max(alpha, ent.value);
            if (ent.flag == TranspositionTable::UPPERBOUND) beta = std::min(beta, ent.value);
            if (alpha >= beta) return ent.value;
        }
    }

    if (depth == 0) {
        return quiescence(ws, board, alpha, beta, plyFromRoot);
    }

    if (depth >= 3 && !board.inCheck(board.sideToMove()) && plyFromRoot > 0 && beta < MATE_SCORE) {
        bool hasBigPieces = board.occupancy(board.sideToMove()) & ~board.pieceBB(board.sideToMove(), Board::PAWN);

        if (hasBigPieces) {
            board.makeNullMove();

            int R = 2;

            int score = -negamax(ws, board, depth - 1 - R, -beta, -beta + 1, plyFromRoot + 1);

            board.unmakeNullMove();

            if (shouldStop()) return 0;

            if (score >= beta) {
                return beta;
            }
        }
    }

    auto moves = board.generatePseudoMoves();

    orderMoves(ws, board, moves, ttMove);

    int bestScore = -INF;
    Move bestMoveInNode;
    int movesSearched = 0;

    for (const auto& move : moves) {
        if (!board.makeMove(move)) {
            continue;
        }

        int score;

        if (movesSearched == 0) {
            score = -negamax(ws, board, depth - 1, -beta, -alpha, plyFromRoot + 1);
        }
        else {
            int reduction = 0;
            if (depth >= 3 && movesSearched >= 4 && !move.isCapture() && !board.inCheck(board.sideToMove())) {
                reduction = 2;
                if (depth - 1 - reduction <= 0) reduction = depth - 2;
            }

            score = -negamax(ws, board, depth - 1 - reduction, -alpha - 1, -alpha, plyFromRoot + 1);

            if (score > alpha && reduction > 0) {
                score = -negamax(ws, board, depth - 1, -alpha - 1, -alpha, plyFromRoot + 1);
            }

            if (score > alpha && score < beta) {
                score = -negamax(ws, board, depth - 1, -beta, -alpha, plyFromRoot + 1);
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
                ws.stats.betaCutoffs++;
                if (movesSearched == 0) ws.stats.firstMoveCutoffs++;

                if (!move.isCapture()) {
                    int side = static_cast<int>(board.sideToMove());
                    ws.history[side][move.start][move.end] += depth * depth;

                    if (ws.history[side][move.start][move.end] > 10000000) {
                        ws.history[side][move.start][move.end] /= 2;
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

int Search::quiescence(WorkerState& ws, Board& board, int alpha, int beta, int plyFromRoot) {
    ws.stats.totalNodes++;
    ws.stats.qNodes++;

    if (plyFromRoot > 64) {
        return evaluator_.evaluate(board, board.sideToMove());
    }

    int standPat = evaluator_.evaluate(board, board.sideToMove());
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    auto allMoves = board.generatePseudoMoves();

    std::vector<Move> captures;
    captures.reserve(allMoves.size());

    for (const auto& m : allMoves) {
        if (m.isCapture() || m.type == MoveType::PROMOTION) {
            captures.push_back(m);
        }
    }

    orderMoves(ws, board, captures, Move());

    for (const auto& move : captures) {
        if (!board.makeMove(move)) {
            continue;
        }

        int score = -quiescence(ws, board, -beta, -alpha, plyFromRoot + 1);

        board.unmakeMove();

        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }
    return alpha;
}

void Search::orderMoves(const WorkerState& ws, Board& board, std::vector<Move>& moves, const Move& ttMove) {
    std::stable_sort(moves.begin(), moves.end(), [&](const Move& a, const Move& b) {
        int scoreA = 0;
        int scoreB = 0;

        if (ttMove.start != ttMove.end) {
            if (a.start == ttMove.start && a.end == ttMove.end) scoreA += 2000000;
            if (b.start == ttMove.start && b.end == ttMove.end) scoreB += 2000000;
        }

        if (a.isCapture()) scoreA += getMvvLvaScore(board, a) + 100000;
        if (b.isCapture()) scoreB += getMvvLvaScore(board, b) + 100000;

        if (a.type == MoveType::PROMOTION) scoreA += 90000;
        if (b.type == MoveType::PROMOTION) scoreB += 90000;

        if (!a.isCapture()) {
            scoreA += ws.history[static_cast<int>(board.sideToMove())][a.start][a.end];
        }
        if (!b.isCapture()) {
            scoreB += ws.history[static_cast<int>(board.sideToMove())][b.start][b.end];
        }

        return scoreA > scoreB;
    });
}