#pragma once

#include <cstdint>
#include <random>
#include <string>
#include <vector>

#include "move.h"

class Board;

// Reads a Polyglot-format opening book (.bin) and probes it by position.
//
// A Book owns one loaded file. Multiple books can coexist as multiple
// instances (e.g. an opening book today, an endgame book later); the
// Engine composes them.
class Book {
public:
    Book();

    bool load(const std::string& path);
    void clear();
    bool isLoaded() const { return !entries_.empty(); }
    std::size_t size() const { return entries_.size(); }

    // Weighted-random pick over all legal entries for this position.
    // Returns an invalid Move() if no entry exists or none decodes legally.
    Move probe(const Board& board) const;

    // Deterministic: highest-weight legal entry (ties: first encountered).
    Move probeBest(const Board& board) const;

    // Polyglot Zobrist hash for the given position. Exposed for tests.
    static uint64_t polyglotKey(const Board& board);

    // Decodes a 16-bit Polyglot move against the position's legal-move list.
    // Resolves castling (king-takes-rook) to the engine's CASTLE_* encoding.
    // Returns invalid Move() if no legal move matches. Exposed for tests.
    static Move decodeMove(uint16_t raw, const Board& board);

    // Seed the RNG (for reproducible tests).
    void seed(uint64_t s) { rng_.seed(s); }

private:
    struct Entry {
        uint64_t key;
        uint16_t move;
        uint16_t weight;
        uint32_t learn;
    };

    std::vector<Entry> entries_;  // sorted by key
    mutable std::mt19937_64 rng_;

    std::vector<std::pair<Move, uint16_t>> gatherLegal(uint64_t key, const Board& board) const;
};
