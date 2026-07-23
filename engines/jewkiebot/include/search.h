#pragma once

#include "board.h"
#include "evaluator.h"
#include "transpositionTable.h"
#include "timeManager.h"
#include "move.h"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

class Search {
public:
    Search(const Evaluator& evaluator, TranspositionTable& tt);

    Move findBestMove(Board& board, int maxDepth, int timeLeftMs = 0, int incrementMs = 0, int movesToGo = 0, bool infinite = false);

    void setThreadCount(int count);
    int getThreadCount() const { return numThreads_; }

    void stop() { stopFlag_.store(true, std::memory_order_relaxed); }

    struct SearchStats {
        long long totalNodes = 0;
        long long qNodes = 0;
        long long ttHits = 0;
        long long ttProbes = 0;
        long long betaCutoffs = 0;
        long long firstMoveCutoffs = 0;
        int selDepth = 0;

        void operator+=(const SearchStats& other) {
            totalNodes += other.totalNodes;
            qNodes += other.qNodes;
            ttHits += other.ttHits;
            ttProbes += other.ttProbes;
            betaCutoffs += other.betaCutoffs;
            firstMoveCutoffs += other.firstMoveCutoffs;
            selDepth = std::max(selDepth, other.selDepth);
        }

        void reset() {
            totalNodes = 0;
            qNodes = 0;
            ttHits = 0;
            ttProbes = 0;
            betaCutoffs = 0;
            firstMoveCutoffs = 0;
            selDepth = 0;
        }
    };

    const SearchStats& getStats() const { return aggregateStats_; }
    void resetStats() { aggregateStats_.reset(); }

    uint64_t getNodes() const { return aggregateStats_.totalNodes; }

private:
    // Aligned so one worker's hot counters never share a cache line with a
    // neighbor's. `nodes` is a periodically-published copy of
    // stats.totalNodes that other threads may read while the search runs;
    // everything else is private to the owning thread until join.
    struct alignas(64) WorkerState {
        std::atomic<long long> nodes{0};
        SearchStats stats;
        int history[2][64][64];
        Move killers[MAX_PLY][2];

        void reset() {
            nodes.store(0, std::memory_order_relaxed);
            stats.reset();
            std::memset(history, 0, sizeof(history));
            for (auto& pair : killers) {
                pair[0] = Move();
                pair[1] = Move();
            }
        }
    };

    const Evaluator& evaluator_;
    TranspositionTable& tt_;
    TimeManager tm_;
    std::atomic<bool> stopFlag_{false};
    int numThreads_;
    SearchStats aggregateStats_;
    std::vector<WorkerState>* activeWorkers_ = nullptr;

    // Cheap hot-path check: a relaxed atomic load only. The wall clock is
    // consulted every 2048 nodes via checkStopPeriodic, which latches the
    // flag so every thread sees the deadline.
    bool stopped() const { return stopFlag_.load(std::memory_order_relaxed); }
    bool checkStopPeriodic(WorkerState& ws);

    long long totalNodesLive() const;

    void helperThreadMain(WorkerState& ws, Board board, int maxDepth, int threadId);

    int searchRoot(WorkerState& ws, Board& board, MoveList& rootMoves, int depth,
                   int alpha, int beta, Move& bestMoveOut, bool report);
    int negamax(WorkerState& ws, Board& board, int depth, int alpha, int beta,
                int plyFromRoot, bool allowNull);
    int quiescence(WorkerState& ws, Board& board, int alpha, int beta, int plyFromRoot);

    void scoreMoves(const WorkerState& ws, const Board& board, const MoveList& moves,
                    const Move& ttMove, int plyFromRoot, int* scores) const;

    std::string pvString(Board& board, const Move& first, int maxLen) const;
    void printInfoScore(int score) const;
};
