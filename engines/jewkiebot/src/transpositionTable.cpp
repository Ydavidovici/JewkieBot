#include "transpositionTable.h"
#include <cstring>

TranspositionTable::TranspositionTable(size_t sizeInMB) {
    resize(sizeInMB);
}

void TranspositionTable::resize(size_t sizeInMB) {
    size_t sizeInBytes = sizeInMB * 1024 * 1024;
    numEntries_ = sizeInBytes / sizeof(Entry);

    table_.resize(numEntries_);
    clear();
}

void TranspositionTable::clear() {
    std::memset(table_.data(), 0xFF, table_.size() * sizeof(Entry));
}

uint32_t TranspositionTable::packMove(const Move& move) {
    uint32_t promotionCode = 0;
    switch (move.promo) {
        case 'Q': promotionCode = 1; break;
        case 'R': promotionCode = 2; break;
        case 'B': promotionCode = 3; break;
        case 'N': promotionCode = 4; break;
        default: break;
    }
    return (static_cast<uint32_t>(move.start) & 0x3F)
         | ((static_cast<uint32_t>(move.end) & 0x3F) << 6)
         | ((static_cast<uint32_t>(move.type) & 0x7) << 12)
         | (promotionCode << 15);
}

Move TranspositionTable::unpackMove(uint32_t packed) {
    static constexpr char promotionChars[8] = {'\0', 'Q', 'R', 'B', 'N', '\0', '\0', '\0'};
    int start = packed & 0x3F;
    int end = (packed >> 6) & 0x3F;
    auto type = static_cast<MoveType>((packed >> 12) & 0x7);
    char promo = promotionChars[(packed >> 15) & 0x7];
    return Move(start, end, type, promo);
}

void TranspositionTable::store(uint64_t key, int value, int depth, Move bestMove, int flag) {
    Entry& entry = table_[indexFor(key)];

    bool isEmpty = (entry.key == UINT64_MAX);
    bool isDeeper = (depth >= entry.depth);

    if (isEmpty || isDeeper) {
        entry.key = key;
        entry.value = value;
        entry.depth = static_cast<int16_t>(depth);
        entry.flag = static_cast<uint8_t>(flag);

        if (bestMove.start != bestMove.end) {
            entry.move = packMove(bestMove);
        }
    }
}

bool TranspositionTable::probe(uint64_t key, TTEntry& out) const {
    const Entry& entry = table_[indexFor(key)];

    if (entry.key == key) {
        out.key = entry.key;
        out.value = entry.value;
        out.depth = entry.depth;
        out.flag = entry.flag;
        out.bestMove = unpackMove(entry.move);
        return true;
    }

    return false;
}
