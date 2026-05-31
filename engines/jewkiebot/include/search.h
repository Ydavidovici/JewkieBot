#pragma once

#include "board.h"
#include "evaluator.h"
#include "transpositionTable.h"
#include "timeManager.h"
#include "move.h"
#include <vector>
#include <atomic>
#include <thread>
#include <cstring>

class Search {
public:
    Search(const Evaluator& evaluator, TranspositionTable& tt);

    Move findBestMove(Board& board, int maxDepth, int timeLeftMs = 0, int incrementMs = 0, int movesToGo = 0, int movetimeMs = 0);

    void setThreadCount(int count);
    int getThreadCount() const { return numThreads_; }

    struct SearchStats {
        long long totalNodes = 0;
        long long qNodes = 0;
        long long ttHits = 0;
        long long ttProbes = 0;
        long long betaCutoffs = 0;
        long long firstMoveCutoffs = 0;

        void operator+=(const SearchStats& other) {
            totalNodes += other.totalNodes;
            qNodes += other.qNodes;
            ttHits += other.ttHits;
            ttProbes += other.ttProbes;
            betaCutoffs += other.betaCutoffs;
            firstMoveCutoffs += other.firstMoveCutoffs;
        }

        void reset() {
            totalNodes = 0;
            qNodes = 0;
            ttHits = 0;
            ttProbes = 0;
            betaCutoffs = 0;
            firstMoveCutoffs = 0;
        }
    };

    const SearchStats& getStats() const { return aggregateStats_; }
    void resetStats() { aggregateStats_.reset(); }

    uint64_t getNodes() const { return aggregateStats_.totalNodes; }

private:
    struct WorkerState {
        SearchStats stats;
        int history[2][64][64];

        void reset() {
            stats.reset();
            std::memset(history, 0, sizeof(history));
        }
    };

    const Evaluator& evaluator_;
    TranspositionTable& tt_;
    TimeManager tm_;
    std::atomic<bool> stopFlag_{false};
    int numThreads_;
    SearchStats aggregateStats_;

    bool shouldStop() const;

    void helperThreadMain(WorkerState& ws, Board board, int maxDepth, int threadId);

    int negamax(WorkerState& ws, Board& board, int depth, int alpha, int beta, int plyFromRoot);
    int quiescence(WorkerState& ws, Board& board, int alpha, int beta, int plyFromRoot);
    void orderMoves(const WorkerState& ws, Board& board, std::vector<Move>& moves, const Move& ttMove);
};
