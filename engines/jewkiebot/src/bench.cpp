#include "bench.h"
#include "main.h"
#include "search.h"
#include <iostream>
#include <chrono>
#include <iomanip>

const std::vector<std::string> Bench::BENCH_FENS = {
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"
};

void Bench::run(Engine& engine, const BenchSettings& settings) {
    std::cout << "--- Starting Benchmark Suite ---\n"; // \n is fine here, we have more coming

    if (settings.runEval) {
        benchmarkEval(engine, settings.evalTimeMs);
        std::cout << "\n";
    }

    if (settings.runSearch) {
        benchmarkSearch(engine, settings);
    }

    std::cout << "--- Benchmark Complete ---" << std::endl;
}

void Bench::benchmarkEval(Engine& engine, int durationMs) {
    std::cout << "[Running Eval Throughput Test (" << durationMs << "ms)]\n";

    long long count = 0;
    auto start = std::chrono::high_resolution_clock::now();

    while (true) {
        auto now = std::chrono::high_resolution_clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count() > durationMs)
            break;

        for (const auto& fen : BENCH_FENS) {
            engine.setPosition(fen);
            volatile int score = engine.evaluator.evaluate(engine.board, engine.board.sideToMove());
            count++;
        }
    }

    auto end = std::chrono::high_resolution_clock::now();
    double duration = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count() / 1000.0;

    std::cout << "Total Evals: " << count << "\n";
    std::cout << "Time:        " << duration << "s\n";
    std::cout << "EPS:         " << (long long)(count / (duration + 0.0001)) << " (Evals Per Second)\n";
}

void Bench::benchmarkSearch(Engine& engine, const BenchSettings& config) {
    std::string modeStr = (config.searchMode == BenchMode::FIXED_DEPTH)
                              ? "Fixed Depth: " + std::to_string(config.searchDepth)
                              : "Fixed Time: " + std::to_string(config.searchTimeMs) + "ms";

    std::cout << "[Running Search Test - " << modeStr << "]\n";
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << std::left << std::setw(30) << "FEN (Partial)"
        << std::setw(12) << "Nodes"
        << std::setw(10) << "Time(s)"
        << std::setw(10) << "NPS"
        << std::setw(10) << "Ordering%" << "\n";
    std::cout << "----------------------------------------------------------------------\n";

    Search::SearchStats cumulativeStats;
    long long totalTimeMs = 0;

    for (const auto& fen : BENCH_FENS) {
        engine.setPosition(fen);
        engine.searcher.resetStats();

        PlaySettings settings{};

        if (config.searchMode == BenchMode::FIXED_DEPTH) {
            settings.depth = config.searchDepth;
            settings.time_left_ms = 99999999;
        }
        else {
            settings.depth = 64;
            settings.time_left_ms = config.searchTimeMs;
        }

        auto start = std::chrono::high_resolution_clock::now();

        engine.playMove(settings);

        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();

        Search::SearchStats currentStats = engine.searcher.getStats();
        cumulativeStats += currentStats;
        totalTimeMs += ms;

        double ordering = 0.0;
        if (currentStats.betaCutoffs > 0) {
            ordering = (double)currentStats.firstMoveCutoffs / currentStats.betaCutoffs * 100.0;
        }

        std::string shortFen = fen.substr(0, 25) + "...";
        std::cout << std::left << std::setw(30) << shortFen
            << std::setw(12) << currentStats.totalNodes
            << std::setw(10) << std::fixed << std::setprecision(3) << (ms / 1000.0)
            << std::setw(10) << (long long)(currentStats.totalNodes / (ms / 1000.0 + 0.0001))
            << std::setw(9) << std::setprecision(1) << ordering << "%\n";
    }

    std::cout << "----------------------------------------------------------------------\n";

    double totalSeconds = totalTimeMs / 1000.0;

    std::cout << "\n=== Aggregate Efficiency Metrics ===\n";
    std::cout << "Total Nodes:      " << cumulativeStats.totalNodes << "\n";
    std::cout << "Total Time:       " << totalSeconds << "s\n";
    std::cout << "Global NPS:       " << (long long)(cumulativeStats.totalNodes / (totalSeconds + 0.0001)) << "\n";

    double orderingEff = 0;
    if (cumulativeStats.betaCutoffs > 0)
        orderingEff = (double)cumulativeStats.firstMoveCutoffs / cumulativeStats.betaCutoffs * 100.0;
    std::cout << "Move Ordering:    " << std::setprecision(1) << orderingEff << "% (First-move cutoffs/Total cutoffs)\n";

    double qSearchLoad = (double)cumulativeStats.qNodes / (cumulativeStats.totalNodes + 1) * 100.0;
    std::cout << "Q-Search Load:    " << std::setprecision(1) << qSearchLoad << "% (Nodes spent in Q-search)\n";

    double ttHitRate = (double)cumulativeStats.ttHits / (cumulativeStats.totalNodes + 1) * 100.0;
    std::cout << "TT Hit Rate:      " << std::setprecision(1) << ttHitRate << "%\n";

    std::cout << std::flush;
}
