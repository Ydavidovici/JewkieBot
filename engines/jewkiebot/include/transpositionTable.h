#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include "move.h"

class TranspositionTable {
public:
    static constexpr int EXACT = 0;
    static constexpr int LOWERBOUND = 1;
    static constexpr int UPPERBOUND = 2;

    // Decoded view of a slot, filled in by probe().
    struct TTEntry {
        uint64_t key;
        int value;
        Move bestMove;
        int depth;
        int flag;
    };

    explicit TranspositionTable(size_t sizeInMB = 64);

    void clear();

    // Public so the UCI "Hash" option can change the table size at runtime.
    // Not thread-safe against a running search; call between searches.
    void resize(size_t sizeInMB);

    void store(uint64_t key, int value, int depth, Move bestMove, int flag);

    bool probe(uint64_t key, TTEntry& out) const;

    size_t entryCount() const { return numEntries_; }

    // Per-mille of sampled slots in use, for "info ... hashfull".
    int hashfull() const;

private:
    // One slot is two 8-byte words. key_xor holds (zobrist ^ data) so a torn
    // read or a torn write from a concurrent thread is detected when the keys
    // no longer match on probe (Hyatt's lockless hashing). data packs:
    //   bits 0-31  value (int32)
    //   bits 32-47 move (Move::pack)
    //   bits 48-55 depth
    //   bits 56-63 flag (FLAG_EMPTY when the slot has never been written)
    struct Slot {
        std::atomic<uint64_t> key_xor{0};
        std::atomic<uint64_t> data{0};
    };

    static constexpr uint64_t FLAG_EMPTY = 0xFF;
    static constexpr uint64_t EMPTY_DATA = FLAG_EMPTY << 56;

    static uint64_t packData(int value, uint16_t move16, int depth, int flag) {
        return static_cast<uint64_t>(static_cast<uint32_t>(value)) |
               static_cast<uint64_t>(move16) << 32 |
               static_cast<uint64_t>(depth & 0xFF) << 48 |
               static_cast<uint64_t>(flag & 0xFF) << 56;
    }

    std::unique_ptr<Slot[]> table_;
    size_t numEntries_ = 0;
    uint64_t indexMask_ = 0;
};
