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

// Transposition‐table flags:
constexpr int EXACT      = 0;
constexpr int ALPHA_FLAG = 1;
constexpr int BETA_FLAG = 2;