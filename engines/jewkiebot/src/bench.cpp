#include "bench.h"
#include "main.h"
#include "search.h"
#include <chrono>
#include <iomanip>
#include <iostream>
#include <sstream>

// Openings, middlegames, tactical positions and endgames (mostly the classic
// Stockfish bench set). With one thread and a cleared TT before each position
// the search is deterministic, so the total node count at a fixed depth is a
// fingerprint of search behaviour: a pure refactor or speed-up must leave it
// unchanged, and a change that alters search or eval records the new number
// ("Bench: <nodes>") in its commit message.
const std::vector<std::string> Bench::BENCH_FENS = {
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 10",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 11",
    "4rrk1/pp1n3p/3q2pQ/2p1pb2/2PP4/2P3N1/P2B2PP/4RRK1 b - - 7 19",
    "rq3rk1/ppp2ppp/1bnpb3/3N2B1/3NP3/7P/PPPQ1PP1/2KR3R w - - 7 14",
    "r1bq1r1k/1pp1n1pp/1p1p4/4p2Q/4Pp2/1BNP4/PPP2PPP/3R1RK1 w - - 2 14",
    "r3r1k1/2p2ppp/p1p1bn2/8/1q2P3/2NPQN2/PPP3PP/R4RK1 b - - 2 15",
    "r1bbk1nr/pp3p1p/2n5/1N4p1/2Np1B2/8/PPP2PPP/2KR1B1R w kq - 0 13",
    "r1bq1rk1/ppp1nppp/4n3/3p3Q/3P4/1BP1B3/PP1N2PP/R4RK1 w - - 1 16",
    "4r1k1/r1q2ppp/ppp2n2/4P3/5Rb1/1N1BQ3/PPP3PP/R5K1 w - - 1 17",
    "2rqkb1r/ppp2p2/2npb1p1/1N1Nn2p/2P1PP2/8/PP2B1PP/R1BQK2R b KQ - 0 11",
    "r1bq1r1k/b1p1npp1/p2p3p/1p6/3PP3/1B2NN2/PP3PPP/R2Q1RK1 w - - 1 16",
    "3r1rk1/p5pp/bpp1pp2/8/q1PP1P2/b3P3/P2NQRPP/1R2B1K1 b - - 6 22",
    "r1q2rk1/2p1bppp/2Pp4/p6b/Q1PNp3/4B3/PP1R1PPP/2K4R w - - 2 18",
    "4k2r/1pb2ppp/1p2p3/1R1p4/3P4/2r1PN2/P4PPP/1R4K1 b - - 3 22",
    "3q2k1/pb3p1p/4pbp1/2r5/PpN2N2/1P2P2P/5PP1/Q2R2K1 b - - 4 26",
    "6k1/6p1/6Pp/ppp5/3pn2P/1P3K2/1PP2P2/8 b - - 3 54",
    "3b4/5kp1/1p1p1p1p/pP1PpP1P/P1P1P3/3KN3/8/8 w - - 0 1",
    "2K5/p7/7P/5pR1/8/5k2/r7/8 w - - 4 3",
    "8/6pk/1p6/8/PP3p1p/5P2/4KP1q/3Q4 w - - 0 1",
    "7k/3p2pp/4q3/8/4Q3/5Kp1/P6b/8 w - - 0 1",
    "8/2p5/8/2kPKp1p/2p4P/2P5/3P4/8 w - - 0 1",
    "8/1p3pp1/7p/5P1P/2k3P1/8/2K2P2/8 w - - 0 1",
    "8/pp2r1k1/2p1p3/3pP2p/1P1P1P1P/P5KR/8/8 w - - 0 1",
    "8/3p4/p1bk3p/Pp6/1Kp1PpPp/2P2P1P/2P5/5B2 b - - 0 1",
    "5k2/7R/4P2p/5K2/p1r2P1p/8/8/8 b - - 0 1",
    "6k1/6p1/P6p/r1N5/5p2/7P/1b3PP1/4R1K1 w - - 0 1",
    "1r3k2/4q3/2Pp3b/3Bp3/2Q2p2/1p1P2P1/1P2KP2/3N4 w - - 0 1",
    "6k1/4pp1p/3p2p1/P1pPb3/R7/1r2P1PP/3B1P2/6K1 w - - 0 1",
    "8/3p3B/5p2/5P2/p7/PP5b/k7/6K1 w - - 0 1",
    "r3k2r/3nnpbp/q2pp1p1/p7/Pp1PPPP1/4BNN1/1P5P/R2Q1RK1 w kq - 0 16",
    "4k3/3q1r2/1N2r1b1/3ppN2/2nPP3/1B1R2n1/2R1Q3/3K4 w - - 5 1",
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

    // Parse every position once up front, so the loop times evaluation only.
    std::vector<Board> boards;
    boards.reserve(BENCH_FENS.size());
    for (const auto& fen : BENCH_FENS) boards.emplace_back(fen);

    long long count = 0;
    auto start = std::chrono::high_resolution_clock::now();

    while (true) {
        auto now = std::chrono::high_resolution_clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count() > durationMs)
            break;

        for (const auto& board : boards) {
            volatile int score = engine.evaluator.evaluate(board, board.sideToMove());
            (void)score;
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
    const bool fixedDepth = (config.searchMode == BenchMode::FIXED_DEPTH);
    std::string modeStr = fixedDepth
                              ? "Fixed Depth: " + std::to_string(config.searchDepth)
                              : "Fixed Time: " + std::to_string(config.searchTimeMs) + "ms (not deterministic)";

    std::cout << "[Running Search Test - " << modeStr << ", " << BENCH_FENS.size() << " positions, 1 thread]\n";
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << std::left << std::setw(30) << "FEN (Partial)"
        << std::setw(12) << "Nodes"
        << std::setw(10) << "Time(s)"
        << std::setw(10) << "NPS"
        << std::setw(10) << "Ordering%" << "\n";
    std::cout << "----------------------------------------------------------------------\n";

    // Determinism: one thread, an empty TT and a fresh board (no game history)
    // for every position, and the searcher called directly so an opening book
    // can't answer instead of searching.
    const int savedThreads = engine.searcher.getThreadCount();
    engine.searcher.setThreadCount(1);

    Search::SearchStats cumulativeStats;
    long long totalTimeMs = 0;
    std::ostringstream discardedInfoLines;

    for (const auto& fen : BENCH_FENS) {
        Board board(fen);
        engine.tt.clear();
        engine.searcher.clearStop();

        auto* realCout = std::cout.rdbuf(discardedInfoLines.rdbuf());  // hide per-depth "info" lines
        auto start = std::chrono::high_resolution_clock::now();
        if (fixedDepth) {
            engine.searcher.findBestMove(board, config.searchDepth, 0, 0, 0, /*infinite=*/true);
        } else {
            engine.searcher.findBestMove(board, 64, config.searchTimeMs, 0, /*movesToGo=*/1);
        }
        auto end = std::chrono::high_resolution_clock::now();
        std::cout.rdbuf(realCout);
        discardedInfoLines.str("");

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

    engine.searcher.setThreadCount(savedThreads);

    std::cout << "----------------------------------------------------------------------\n";

    double totalSeconds = totalTimeMs / 1000.0;
    long long nps = (long long)(cumulativeStats.totalNodes / (totalSeconds + 0.0001));

    std::cout << "\n=== Aggregate Efficiency Metrics ===\n";
    std::cout << "Total Nodes:      " << cumulativeStats.totalNodes << "\n";
    std::cout << "Total Time:       " << totalSeconds << "s\n";
    std::cout << "Global NPS:       " << nps << "\n";

    double orderingEff = 0;
    if (cumulativeStats.betaCutoffs > 0)
        orderingEff = (double)cumulativeStats.firstMoveCutoffs / cumulativeStats.betaCutoffs * 100.0;
    std::cout << "Move Ordering:    " << std::setprecision(1) << orderingEff << "% (First-move cutoffs/Total cutoffs)\n";

    double qSearchLoad = (double)cumulativeStats.qNodes / (cumulativeStats.totalNodes + 1) * 100.0;
    std::cout << "Q-Search Load:    " << std::setprecision(1) << qSearchLoad << "% (Nodes spent in Q-search)\n";

    // Hits per probe. Probes happen in the main search only (not quiescence),
    // so this is the share of main-search nodes the table could answer.
    double ttHitRate = (double)cumulativeStats.ttHits / (cumulativeStats.ttProbes + 1) * 100.0;
    std::cout << "TT Hit Rate:      " << std::setprecision(1) << ttHitRate << "% (hits/probes)\n";

    // One machine-readable line: the fingerprint for commit messages and CI.
    std::cout << "\nBench: " << cumulativeStats.totalNodes << " nodes " << nps << " nps\n";

    std::cout << std::flush;
}
