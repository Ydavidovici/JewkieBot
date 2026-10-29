#pragma once

#include "board.h"
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

// Count the leaf nodes of the move tree to `depth`, enumerating moves exactly
// the way the search does: pseudo-legal generation, with legality decided by
// makeMove(). generateLegalMoves() has extra checks of its own (castling), so
// a perft built on it would miss bugs that only the search's path has.
uint64_t perft(Board& board, int depth);

// Per-root-move counts ("divide"), for locating a wrong count by comparing
// against a reference engine move by move. Returns {uci move, nodes} pairs.
std::vector<std::pair<std::string, uint64_t>> perftDivide(Board& board, int depth);
