#pragma once

#include "board.h"
#include <vector>
#include <cstdint>
#include <string>
#include <functional>

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

    // Apply a tuned parameter vector from a text file (whitespace-separated
    // integers, in getParameter index order) and rebuild the derived tables.
    // Returns false if the file can't be opened or held no values.
    bool loadParametersFromFile(const std::string& path);

    // Dump the current parameters as one integer per line (getParameter order),
    // so a caller can read back defaults / what's currently applied.
    std::string exportParameters() const;

    // Texel coordinate-descent tuning against an EPD dataset (each line a FEN
    // followed by c9 "<result>", result in {1.0,0.5,0.0} or PGN tokens). Mutates
    // this evaluator toward the params that minimise sigmoid MSE, writes them as
    // a raw one-per-line vector to outputPath, and calls onEpoch(epoch, mse) each
    // pass (epoch 0 = initial). Returns false on a missing/empty dataset or write
    // failure. Stops early when an epoch yields no improvement.
    bool tuneFromDataset(const std::string& datasetPath, const std::string& outputPath,
                         int maxEpochs, const std::function<void(int, double)>& onEpoch);

private:
    int evaluateMaterial(const Board& board) const;
    int evaluatePositional(const Board& board) const;

    static constexpr int SCALAR_PARAM_COUNT = 12;
    int* scalarParams(int index);

    // Structural/activity heuristics, each scored for one color; evaluate()
    // takes white's total minus black's.
    int pawnStructureScore(const Board& board, Color color) const;
    int pieceActivityScore(const Board& board, Color color) const;
    int kingShelterScore(const Board& board, Color color) const;

    // Heuristic weights in centipawns. Penalties are stored positive and
    // subtracted where applied. All are exposed through getParameter/
    // setParameter (after the PSTs) so Texel-style tuning against the game
    // database can adjust them.
    int doubledPawnPenalty = 12;
    int isolatedPawnPenalty = 10;
    int bishopPairBonus = 30;
    int rookOpenFileBonus = 20;
    int rookSemiOpenFileBonus = 10;
    int mobilityWeights[4] = {4, 3, 2, 1};  // knight, bishop, rook, queen — per reachable square
    int shelterCloseBonus = 10;             // friendly pawn directly in front of the king
    int shelterFarBonus = 5;                // friendly pawn two ranks in front
    int kingOpenFilePenalty = 15;           // no friendly pawn at all on/next to the king's file
    int passedPawnBonus[8] = {0, 10, 15, 25, 40, 65, 100, 0};  // by relative rank

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
