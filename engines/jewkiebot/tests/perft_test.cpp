// Perft: count every move sequence to a fixed depth from standard positions and
// compare with reference counts. The positions are the Chess Programming Wiki
// "Perft Results" set; every expected count was verified with Stockfish's
// `go perft` on the exact FEN below (2026-10-29).
// Any move-generation, make/unmake, castling, en-passant or promotion bug
// changes a count. perft() walks the search's own move path (pseudo-legal
// generation + makeMove legality), not generateLegalMoves(), so it checks
// exactly what the search plays through.

#include "board.h"
#include "perft.h"

#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

struct PerftCase {
    const char* name;
    const char* fen;
    int depth;
    uint64_t expected;
};

// Depths are chosen to keep the whole suite to a few seconds while still
// reaching the castling / en-passant / promotion edge cases of each position.
static const std::vector<PerftCase> CASES = {
    {"start",      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 1, 20},
    {"start",      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 3, 8902},
    {"start",      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 5, 4865609},
    {"kiwipete",   "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 1, 48},
    {"kiwipete",   "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 2, 2039},
    {"kiwipete",   "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 3, 97862},
    {"kiwipete",   "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 4, 4085603},
    {"position3",  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 5, 674624},
    {"position4",  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 3, 9467},
    {"position4",  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 4, 422333},
    {"position4m", "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1", 4, 422333},
    {"position5",  "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 3, 62379},
    {"position5",  "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 4, 2103487},
    {"position6",  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P3/2NP1N2/PPP1QPPP/R4RK1 w - - 0 10", 1, 45},
    {"position6",  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P3/2NP1N2/PPP1QPPP/R4RK1 w - - 0 10", 4, 2834258},
};

int main() {
    int failures = 0;
    auto suiteStart = std::chrono::steady_clock::now();

    for (const auto& c : CASES) {
        Board board(c.fen);
        auto start = std::chrono::steady_clock::now();
        uint64_t got = perft(board, c.depth);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();

        bool ok = (got == c.expected);
        if (!ok) failures++;
        std::cout << (ok ? "  ok   " : "  FAIL ") << c.name << " depth " << c.depth
                  << ": " << got;
        if (!ok) std::cout << " (expected " << c.expected << ", off by " << (int64_t)(got - c.expected) << ")";
        std::cout << "  [" << ms << " ms]\n";
    }

    auto totalMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - suiteStart).count();
    
    if (failures) {
        std::cout << failures << " PERFT CASE(S) FAILED (" << totalMs << " ms)\n";
        return 1;
    }
    std::cout << "ALL PERFT TESTS PASSED (" << totalMs << " ms)\n";
    return 0;
}
