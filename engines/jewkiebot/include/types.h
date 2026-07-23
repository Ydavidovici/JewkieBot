// types.h
#pragma once

enum class Color { WHITE, BLACK };

enum class MoveType {
    NORMAL,
    CAPTURE,
    CASTLE_KINGSIDE,
    CASTLE_QUEENSIDE,
    PROMOTION,
    EN_PASSANT,
    INVALID
};

// Search-wide score constants. MATE_SCORE is the value of delivering mate at
// the root; mate scores found deeper in the tree are offset by their ply so
// that shorter mates always score higher. Anything above MATE_BOUND is a mate
// score and must be ply-adjusted when stored in / loaded from the TT.
constexpr int SCORE_INF   = 1000000;
constexpr int MATE_SCORE  = 100000;
constexpr int MATE_BOUND  = MATE_SCORE - 1000;
constexpr int MAX_PLY     = 128;
