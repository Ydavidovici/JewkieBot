#pragma once

#include <string>
#include <array>
#include <cassert>
#include <cstdint>
#include "types.h"

constexpr int MAX_MOVES = 256;

struct Move {
    int start;
    int end;
    MoveType type;
    char promo;

    Move(): start(-1), end(-1), type(MoveType::INVALID), promo('\0') {}

    Move(int s, int e, MoveType t = MoveType::NORMAL, char p = '\0')
        : start(s), end(e), type(t), promo(p) {}

    bool isValid() const;
    bool isCapture() const;
    std::string toString() const;

    bool operator==(const Move& o) const {
        return start == o.start
            && end == o.end
            && type == o.type
            && promo == o.promo;
    }

    // Compact 16-bit encoding used by the transposition table:
    // bits 0-5 from-square, 6-11 to-square, 12-15 a nibble that is either the
    // MoveType (0-6) or 8+promoIndex for promotions. 0 encodes "no move".
    uint16_t pack() const {
        if (start < 0 || end < 0 || start == end || type == MoveType::INVALID) return 0;
        uint16_t nibble;
        if (type == MoveType::PROMOTION) {
            uint16_t promoIndex = 0; // Q
            if (promo == 'R') promoIndex = 1;
            else if (promo == 'B') promoIndex = 2;
            else if (promo == 'N') promoIndex = 3;
            nibble = 8 + promoIndex;
        } else {
            nibble = static_cast<uint16_t>(type);
        }
        return static_cast<uint16_t>(start) |
               static_cast<uint16_t>(end) << 6 |
               nibble << 12;
    }

    static Move unpack(uint16_t bits) {
        if (bits == 0) return Move();
        int s = bits & 0x3F;
        int e = (bits >> 6) & 0x3F;
        uint16_t nibble = bits >> 12;
        if (nibble >= 8) {
            static constexpr char promoChars[4] = {'Q', 'R', 'B', 'N'};
            return Move(s, e, MoveType::PROMOTION, promoChars[nibble - 8]);
        }
        if (nibble > static_cast<uint16_t>(MoveType::INVALID)) return Move();
        return Move(s, e, static_cast<MoveType>(nibble));
    }

    static Move fromUCI(const std::string& uci) {
        if (uci.size() < 4) return Move();
        int f0 = uci[0] - 'a';
        int r0 = uci[1] - '1';
        int f1 = uci[2] - 'a';
        int r1 = uci[3] - '1';
        if (f0 < 0 || f0 > 7 || r0 < 0 || r0 > 7 || f1 < 0 || f1 > 7 || r1 < 0 || r1 > 7)
            return Move();
        int s = r0 * 8 + f0;
        int e = r1 * 8 + f1;
        if (uci.size() == 5) {
            char p = std::toupper(uci[4]);
            return Move(s, e, MoveType::PROMOTION, p);
        }
        return Move(s, e);
    }
};

struct MoveList {
    std::array<Move, MAX_MOVES> moves;
    int count = 0;

    MoveList() : count(0) {}

    void push_back(const Move& m) {
        assert(count < MAX_MOVES);
        moves[count++] = m;
    }

    Move& operator[](int index) {
        assert(index >= 0 && index < count);
        return moves[index];
    }

    const Move& operator[](int index) const {
        assert(index >= 0 && index < count);
        return moves[index];
    }

    int size() const {
        return count;
    }

    bool empty() const {
        return count == 0;
    }

    void clear() {
        count = 0;
    }

    Move* begin() { return moves.data(); }
    Move* end() { return moves.data() + count; }

    const Move* begin() const { return moves.data(); }
    const Move* end() const { return moves.data() + count; }
};
