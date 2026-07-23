#include "transpositionTable.h"

#include <algorithm>
#include <bit>

TranspositionTable::TranspositionTable(size_t sizeInMB) {
    resize(sizeInMB);
}

void TranspositionTable::resize(size_t sizeInMB) {
    size_t sizeInBytes = std::max<size_t>(1, sizeInMB) * 1024 * 1024;

    // Power-of-two entry count so probes index with a mask instead of an
    // integer division on the hot path.
    numEntries_ = std::bit_floor(sizeInBytes / sizeof(Slot));
    indexMask_ = numEntries_ - 1;

    table_ = std::make_unique<Slot[]>(numEntries_);
    clear();
}

void TranspositionTable::clear() {
    for (size_t i = 0; i < numEntries_; ++i) {
        table_[i].key_xor.store(0, std::memory_order_relaxed);
        table_[i].data.store(EMPTY_DATA, std::memory_order_relaxed);
    }
}

void TranspositionTable::store(uint64_t key, int value, int depth, Move bestMove, int flag) {
    Slot& slot = table_[key & indexMask_];

    uint64_t oldData = slot.data.load(std::memory_order_relaxed);
    int oldFlag = static_cast<int>(oldData >> 56);
    int oldDepth = static_cast<int>((oldData >> 48) & 0xFF);

    bool isEmpty = (oldFlag == static_cast<int>(FLAG_EMPTY));
    bool isDeeper = (depth >= oldDepth);

    if (!isEmpty && !isDeeper) return;

    uint16_t move16 = bestMove.pack();
    if (move16 == 0) {
        // Keep the previously stored move when the new result has none —
        // a bound-only store must not erase ordering information.
        move16 = static_cast<uint16_t>((oldData >> 32) & 0xFFFF);
    }

    uint64_t data = packData(value, move16, std::clamp(depth, 0, 255), flag);
    slot.data.store(data, std::memory_order_relaxed);
    slot.key_xor.store(key ^ data, std::memory_order_relaxed);
}

bool TranspositionTable::probe(uint64_t key, TTEntry& out) const {
    const Slot& slot = table_[key & indexMask_];

    uint64_t keyXor = slot.key_xor.load(std::memory_order_relaxed);
    uint64_t data = slot.data.load(std::memory_order_relaxed);

    int flag = static_cast<int>(data >> 56);
    if (flag == static_cast<int>(FLAG_EMPTY)) return false;
    if ((keyXor ^ data) != key) return false;

    out.key = key;
    out.value = static_cast<int32_t>(data & 0xFFFFFFFFULL);
    out.bestMove = Move::unpack(static_cast<uint16_t>((data >> 32) & 0xFFFF));
    out.depth = static_cast<int>((data >> 48) & 0xFF);
    out.flag = flag;
    return true;
}

int TranspositionTable::hashfull() const {
    size_t sample = std::min<size_t>(1000, numEntries_);
    if (sample == 0) return 0;

    size_t used = 0;
    for (size_t i = 0; i < sample; ++i) {
        uint64_t data = table_[i].data.load(std::memory_order_relaxed);
        if ((data >> 56) != FLAG_EMPTY) ++used;
    }
    return static_cast<int>(used * 1000 / sample);
}
