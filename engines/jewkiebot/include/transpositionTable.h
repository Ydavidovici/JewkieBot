#pragma once

#include <cstdint>
#include <vector>
#include "move.h"

class TranspositionTable {
public:
    static constexpr int EXACT = 0;
    static constexpr int LOWERBOUND = 1;
    static constexpr int UPPERBOUND = 2;

    // Probe result / public view of an entry.
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

    // Number of slots; two keys collide iff key % entryCount() matches.
    size_t entryCount() const { return numEntries_; }

private:
    // Packed storage entry: 24 bytes instead of the previous 40, so the same
    // table size holds ~1.7x more positions. The move is packed into 18 bits
    // (start 6 | end 6 | type 3 | promo 3).
    struct Entry {
        uint64_t key;
        int32_t value;
        uint32_t move;
        int16_t depth;
        uint8_t flag;
        uint8_t unused;
    };

    std::vector<Entry> table_;
    size_t numEntries_;

    size_t indexFor(uint64_t key) const { return key % numEntries_; }

    static uint32_t packMove(const Move& m);
    static Move unpackMove(uint32_t packed);

    void resize(size_t sizeInMB);
};
