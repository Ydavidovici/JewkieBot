#include "transpositionTable.h"
#include <cstring>

TranspositionTable::TranspositionTable(size_t sizeInMB) {
    resize(sizeInMB);
}

void TranspositionTable::resize(size_t sizeInMB) {
    size_t sizeInBytes = sizeInMB * 1024 * 1024;
    numEntries_ = sizeInBytes / sizeof(TTEntry);

    table_.resize(numEntries_);
    clear();
}

void TranspositionTable::clear() {
    std::memset(table_.data(), 0xFF, table_.size() * sizeof(TTEntry));
}

void TranspositionTable::store(uint64_t key, int value, int depth, Move bestMove, int flag) {
    size_t index = key % numEntries_;
    TTEntry& entry = table_[index];

    bool isEmpty = (entry.key == UINT64_MAX);
    bool isDeeper = (depth >= entry.depth);

    if (isEmpty || isDeeper) {
        entry.key = key;
        entry.value = value;
        entry.depth = depth;
        entry.flag = flag;

        if (bestMove.start != bestMove.end) {
            entry.bestMove = bestMove;
        }
    }
}

bool TranspositionTable::probe(uint64_t key, TTEntry& out) const {
    size_t index = key % numEntries_;
    const TTEntry& entry = table_[index];

    if (entry.key == key) {
        out = entry;
        return true;
    }

    return false;
}