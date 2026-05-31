#pragma once

#include <cstdint>
#include <vector>
#include "move.h"

class TranspositionTable {
public:
    static constexpr int EXACT = 0;
    static constexpr int LOWERBOUND = 1;
    static constexpr int UPPERBOUND = 2;

    struct TTEntry {
        uint64_t key;
        int value;
        Move bestMove;
        int depth;
        int flag;
    };

    TranspositionTable(size_t sizeInMB = 1024);

    void clear();

    void store(uint64_t key, int value, int depth, Move bestMove, int flag);

    bool probe(uint64_t key, TTEntry& out) const;

private:
    std::vector<TTEntry> table_;
    size_t numEntries_;

    void resize(size_t sizeInMB);
};