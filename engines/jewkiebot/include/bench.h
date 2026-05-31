#pragma once
#include "main.h"
#include <string>
#include <vector>

enum class BenchMode {
    FIXED_DEPTH,
    FIXED_TIME
};

struct BenchSettings {
    bool runEval = true;
    int evalTimeMs = 2000;
    bool runSearch = true;
    BenchMode searchMode = BenchMode::FIXED_DEPTH;
    int searchDepth = 9;
    int searchTimeMs = 1000;
};

class Bench {
public:
    static const std::vector<std::string> BENCH_FENS;

    static void run(Engine& engine, const BenchSettings& settings);

private:
    static void benchmarkEval(Engine& engine, int durationMs);
    static void benchmarkSearch(Engine& engine, const BenchSettings& settings);
};