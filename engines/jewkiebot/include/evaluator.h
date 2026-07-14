#pragma once

#include "board.h"
#include <vector>
#include <cstdint>

class Evaluator {
public:
    static constexpr int PST_COUNT = 6;

    Evaluator();

    int evaluate(const Board& board, Color side_to_move) const;
    static int evaluateTerminal(const Board& board, Color side_to_move);

    // For Texel Tuning
    int getParameterCount() const;
    int getParameter(int index) const;
    void setParameter(int index, int value);
    void updateBlackTables();

private:
    int evaluateMaterial(const Board& board) const;
    int evaluatePositional(const Board& board) const;

    int pieceValues[PST_COUNT] = {100, 320, 330, 500, 900, 20000};

    std::array<int, 64> whitePawnTable{};
    std::array<int, 64> whiteKnightTable{};
    std::array<int, 64> whiteBishopTable{};
    std::array<int, 64> whiteRookTable{};
    std::array<int, 64> whiteQueenTable{};
    std::array<int, 64> whiteKingTableMG{};
    std::array<int, 64> whiteKingTableEG{};

    std::array<int, 64> blackPawnTable{};
    std::array<int, 64> blackKnightTable{};
    std::array<int, 64> blackBishopTable{};
    std::array<int, 64> blackRookTable{};
    std::array<int, 64> blackQueenTable{};
    std::array<int, 64> blackKingTableMG{};
    std::array<int, 64> blackKingTableEG{};

    // pieceValues[p] + PST[sq], precombined by updateBlackTables() so
    // evaluate() does a single lookup per piece. [0]=white, [1]=black.
    int combinedTables[2][PST_COUNT][64]{};

    void initializePieceSquareTables();
};
