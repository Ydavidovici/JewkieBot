#pragma once

#include "board.h"
#include <array>
#include <vector>
#include <cstdint>
#include <string>
#include <functional>

// A middlegame/endgame pair. evaluate() sums both halves over every term and
// blends them by game phase: (mg * phase + eg * (24 - phase)) / 24.
struct EvalScore {
    int mg = 0;
    int eg = 0;
};

// Index layout of the evaluation parameters (Evaluator::params). Every
// parameter is an EvalScore, from White's point of view; Black's terms use
// the same parameters with the board mirrored (PST square ^ 56) and the sign
// flipped. Penalties are stored as negative values and added.
namespace EvalParam {
    enum : int {
        MATERIAL = 0,                              // P, N, B, R, Q (the king is a constant)
        PST = MATERIAL + 5,                        // 6 pieces x 64 squares, square 0 = a1
        PASSED_PAWN = PST + 6 * 64,                // by relative rank 0..7
        DOUBLED_PAWN = PASSED_PAWN + 8,            // per extra pawn on a file
        ISOLATED_PAWN,
        BISHOP_PAIR,
        ROOK_OPEN_FILE,
        ROOK_SEMI_OPEN_FILE,
        MOBILITY,                                  // N, B, R, Q: per reachable square
        SHELTER_CLOSE = MOBILITY + 4,              // own pawn directly in front of the king
        SHELTER_FAR,                               // own pawn two ranks in front
        KING_OPEN_FILE,                            // no own pawn on/next to the king's file
        TEMPO,                                     // side to move
        COUNT
    };
}

class Evaluator {
public:
    static constexpr int PHASE_MAX = 24;           // N=1, B=1, R=2, Q=4 per piece
    static constexpr int KING_VALUE = 20000;       // not tuned: both kings are always on

    Evaluator();

    int evaluate(const Board& board, Color side_to_move) const;
    static int evaluateTerminal(const Board& board, Color side_to_move);
    static int gamePhase(const Board& board);

    // The parameters each term of the evaluation uses in this position, as
    // (EvalParam index, White count minus Black count) pairs, plus the phase.
    // evaluate() equals sum(count * param), tapered (up to rounding), so a
    // tuner can evaluate and differentiate positions without the board.
    struct Trace {
        std::vector<std::pair<int16_t, int16_t>> terms;
        int phase = 0;
        int kings = 0;     // white kings minus black kings (KING_VALUE each)
    };
    Trace trace(const Board& board) const;

    // Flat integer view of the parameters for tuning and the params file:
    // index 2 * p is params[p].mg, 2 * p + 1 is params[p].eg.
    int getParameterCount() const;
    int getParameter(int index) const;
    void setParameter(int index, int value);

    // Params file: a header line "# jewkiebot-eval v2 <count>" followed by
    // getParameterCount() integers in getParameter order. A file with a
    // missing or different header, or the wrong number of values, is refused
    // and the current values are kept (an old layout would load garbage).
    static std::string paramsFileHeader();
    bool loadParametersFromFile(const std::string& path, std::string* error = nullptr);
    std::string exportParameters() const;   // header line + one value per line

    // Texel tuning (src/tuner.cpp) against an EPD dataset: each line a FEN
    // followed by c9 "<result>", as 1-0/0-1/1/2-1/2 or 1.0/0.5/0.0. Fits the
    // sigmoid scale K, then runs up to maxEpochs full-batch Adam steps on the
    // traces, holding out every tenth position. Keeps the parameters with the
    // best validation error, applies them to this evaluator, and writes them
    // to outputPath (params-file format). Calls onEpoch(epoch, training mse)
    // at epoch 0 and every 50 epochs, and prints "info string tune: ..." lines.
    // Stops early once validation error hasn't improved for 300 epochs.
    // Returns false on a missing/empty dataset or a write failure.
    bool tuneFromDataset(const std::string& datasetPath, const std::string& outputPath,
                         int maxEpochs, const std::function<void(int, double)>& onEpoch);

private:
    std::array<EvalScore, EvalParam::COUNT> params{};

    // Material + PST fused per [color][piece][square] (Black's entries mirrored
    // and negated), so evaluate() does one lookup per piece. Rebuilt whenever
    // a material or PST parameter changes; trace() reads params directly, and
    // eval_params_test checks the two agree.
    EvalScore pieceSquare[2][6][64]{};
    void rebuildPieceSquare();

    // Visits every term of the evaluation, calling sink.add(param, count)
    // with White-minus-Black counts. evaluate() and trace() both run it, so
    // the tuner always sees exactly the evaluation the search uses.
    template <typename Sink> void walkTerms(const Board& board, Sink& sink) const;
    template <typename Sink> void walkPawnStructure(const Board& board, Color color, int sign, Sink& sink) const;
    template <typename Sink> void walkPieceActivity(const Board& board, Color color, int sign, Sink& sink) const;
    template <typename Sink> void walkKingShelter(const Board& board, Color color, int sign, Sink& sink) const;

    void initializeDefaults();
};
