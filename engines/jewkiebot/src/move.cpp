#include "move.h"
#include <cctype>

bool Move::isValid() const {
    return start >= 0 && start < 64
        && end   >= 0 && end   < 64
        && type  != MoveType::INVALID;
}

bool Move::isCapture() const {
    return type == MoveType::CAPTURE
        || type == MoveType::EN_PASSANT;
}

std::string Move::toString() const {
    auto toSq = [](int sq) {
        char file = 'a' + (sq % 8);
        char rank = '1' + (sq / 8);
        return std::string{file, rank};
    };

    std::string s = toSq(start) + toSq(end);
    if (promo != '\0') {
        // UCI wants the promotion piece lowercase ("e7e8q"); GUIs and match
        // runners reject "e7e8Q" as an illegal move. Stored uppercase internally.
        s += static_cast<char>(std::tolower(static_cast<unsigned char>(promo)));
    }
    return s;
}
