#include "evaluator.h"
#include "evalDefaults.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <mutex>
#include <sstream>
#include <vector>

namespace {

constexpr uint64_t FILE_A_MASK = 0x0101010101010101ULL;

inline uint64_t fileMask(int file) { return FILE_A_MASK << file; }

inline uint64_t adjacentFilesMask(int file) {
    uint64_t mask = 0;
    if (file > 0) mask |= fileMask(file - 1);
    if (file < 7) mask |= fileMask(file + 1);
    return mask;
}

// passed_pawn_masks[color][square]: every square an enemy pawn would have to
// occupy to stop this pawn — same file and both adjacent files, all ranks
// strictly ahead of the pawn from `color`'s point of view.
uint64_t passed_pawn_masks[2][64];
std::once_flag eval_masks_once;

void initEvalMasks() {
    std::call_once(eval_masks_once, []() {
        for (int square = 0; square < 64; ++square) {
            int file = square % 8;
            int rank = square / 8;

            uint64_t files = fileMask(file) | adjacentFilesMask(file);

            uint64_t ahead_of_white = 0;
            for (int r = rank + 1; r < 8; ++r) ahead_of_white |= 0xFFULL << (r * 8);
            uint64_t ahead_of_black = 0;
            for (int r = rank - 1; r >= 0; --r) ahead_of_black |= 0xFFULL << (r * 8);

            passed_pawn_masks[static_cast<int>(Color::WHITE)][square] = files & ahead_of_white;
            passed_pawn_masks[static_cast<int>(Color::BLACK)][square] = files & ahead_of_black;
        }
    });
}

// Sums the terms into a middlegame and an endgame score (evaluate()).
struct ScoreSink {
    const EvalScore* params;
    const EvalScore (*pieceSquare)[6][64];
    int mg = 0;
    int eg = 0;
    void add(int param, int count) {
        mg += params[param].mg * count;
        eg += params[param].eg * count;
    }
    // One piece of `color` (0 white, 1 black): material + PST, pre-fused.
    void addPiece(int color, int piece, int square) {
        mg += pieceSquare[color][piece][square].mg;
        eg += pieceSquare[color][piece][square].eg;
    }
};

// Counts how often each parameter is used (trace()).
struct TraceSink {
    std::array<int, EvalParam::COUNT> counts{};
    void add(int param, int count) { counts[param] += count; }
    void addPiece(int color, int piece, int square) {
        const int sign = (color == 0 ? 1 : -1);
        if (piece < Board::KING) counts[EvalParam::MATERIAL + piece] += sign;
        counts[EvalParam::PST + piece * 64 + (color == 0 ? square : square ^ 56)] += sign;
    }
};

} // namespace

Evaluator::Evaluator() {
    initEvalMasks();
    initializeDefaults();
}

int Evaluator::gamePhase(const Board& board) {
    const int phase =
        std::popcount(board.pieceBB(Color::WHITE, Board::KNIGHT)) +
        std::popcount(board.pieceBB(Color::BLACK, Board::KNIGHT)) +
        std::popcount(board.pieceBB(Color::WHITE, Board::BISHOP)) +
        std::popcount(board.pieceBB(Color::BLACK, Board::BISHOP)) +
        2 * std::popcount(board.pieceBB(Color::WHITE, Board::ROOK)) +
        2 * std::popcount(board.pieceBB(Color::BLACK, Board::ROOK)) +
        4 * std::popcount(board.pieceBB(Color::WHITE, Board::QUEEN)) +
        4 * std::popcount(board.pieceBB(Color::BLACK, Board::QUEEN));
    return std::min(phase, PHASE_MAX);
}

int Evaluator::evaluate(const Board& board, Color sideToMove) const {
    ScoreSink sink{params.data(), pieceSquare};
    walkTerms(board, sink);

    // Tapered: the middlegame score with all pieces on (phase 24), sliding
    // to the endgame score as material comes off.
    const int phase = gamePhase(board);
    int score = (sink.mg * phase + sink.eg * (PHASE_MAX - phase)) / PHASE_MAX;
    score += KING_VALUE * (std::popcount(board.pieceBB(Color::WHITE, Board::KING)) -
                           std::popcount(board.pieceBB(Color::BLACK, Board::KING)));

    return (sideToMove == Color::WHITE ? score : -score);
}

Evaluator::Trace Evaluator::trace(const Board& board) const {
    TraceSink sink;
    walkTerms(board, sink);

    Trace t;
    for (int p = 0; p < EvalParam::COUNT; ++p) {
        if (sink.counts[p]) t.terms.emplace_back(static_cast<int16_t>(p), static_cast<int16_t>(sink.counts[p]));
    }
    t.phase = gamePhase(board);
    t.kings = std::popcount(board.pieceBB(Color::WHITE, Board::KING)) -
              std::popcount(board.pieceBB(Color::BLACK, Board::KING));
    return t;
}

template <typename Sink>
void Evaluator::walkTerms(const Board& board, Sink& sink) const {
    // Material (pawn..queen) and piece-square tables. Black's squares are
    // mirrored (sq ^ 56) so one White-oriented table serves both colors.
    for (int piece = 0; piece <= Board::KING; ++piece) {
        const auto pieceIndex = static_cast<Board::PieceIndex>(piece);

        uint64_t white = board.pieceBB(Color::WHITE, pieceIndex);
        while (white) {
            sink.addPiece(0, piece, std::countr_zero(white));
            white &= white - 1;
        }

        uint64_t black = board.pieceBB(Color::BLACK, pieceIndex);
        while (black) {
            sink.addPiece(1, piece, std::countr_zero(black));
            black &= black - 1;
        }
    }

    walkPawnStructure(board, Color::WHITE, 1, sink);
    walkPawnStructure(board, Color::BLACK, -1, sink);
    walkPieceActivity(board, Color::WHITE, 1, sink);
    walkPieceActivity(board, Color::BLACK, -1, sink);
    walkKingShelter(board, Color::WHITE, 1, sink);
    walkKingShelter(board, Color::BLACK, -1, sink);

    sink.add(EvalParam::TEMPO, board.sideToMove() == Color::WHITE ? 1 : -1);
}

// Doubled and isolated pawns are penalized; passed pawns are rewarded more
// the closer they get to promotion.
template <typename Sink>
void Evaluator::walkPawnStructure(const Board& board, Color color, int sign, Sink& sink) const {
    Color enemy = (color == Color::WHITE ? Color::BLACK : Color::WHITE);
    uint64_t ownPawns = board.pieceBB(color, Board::PAWN);
    uint64_t enemyPawns = board.pieceBB(enemy, Board::PAWN);

    for (int file = 0; file < 8; ++file) {
        int pawnsOnFile = std::popcount(ownPawns & fileMask(file));
        if (pawnsOnFile > 1) sink.add(EvalParam::DOUBLED_PAWN, sign * (pawnsOnFile - 1));
    }

    uint64_t scan = ownPawns;
    while (scan) {
        int square = std::countr_zero(scan);
        scan &= scan - 1;
        int file = square % 8;

        if (!(ownPawns & adjacentFilesMask(file))) sink.add(EvalParam::ISOLATED_PAWN, sign);

        if (!(passed_pawn_masks[static_cast<int>(color)][square] & enemyPawns)) {
            int relativeRank = (color == Color::WHITE ? square / 8 : 7 - square / 8);
            sink.add(EvalParam::PASSED_PAWN + relativeRank, sign);
        }
    }
}

// "Passive pieces" in numbers: each knight/bishop/rook/queen earns a small
// bonus per square it can reach, so pieces stuck behind their own pawns
// score low. Adds the bishop pair and rooks on (semi-)open files.
template <typename Sink>
void Evaluator::walkPieceActivity(const Board& board, Color color, int sign, Sink& sink) const {
    Color enemy = (color == Color::WHITE ? Color::BLACK : Color::WHITE);
    uint64_t own = board.occupancy(color);
    uint64_t all = own | board.occupancy(enemy);
    uint64_t ownPawns = board.pieceBB(color, Board::PAWN);
    uint64_t enemyPawns = board.pieceBB(enemy, Board::PAWN);

    if (std::popcount(board.pieceBB(color, Board::BISHOP)) >= 2) sink.add(EvalParam::BISHOP_PAIR, sign);

    uint64_t knights = board.pieceBB(color, Board::KNIGHT);
    while (knights) {
        int square = std::countr_zero(knights);
        knights &= knights - 1;
        sink.add(EvalParam::MOBILITY + 0, sign * std::popcount(Board::knightAttackMask(square) & ~own));
    }

    uint64_t bishops = board.pieceBB(color, Board::BISHOP);
    while (bishops) {
        int square = std::countr_zero(bishops);
        bishops &= bishops - 1;
        sink.add(EvalParam::MOBILITY + 1, sign * std::popcount(Board::bishopAttackMask(square, all) & ~own));
    }

    uint64_t rooks = board.pieceBB(color, Board::ROOK);
    while (rooks) {
        int square = std::countr_zero(rooks);
        rooks &= rooks - 1;
        sink.add(EvalParam::MOBILITY + 2, sign * std::popcount(Board::rookAttackMask(square, all) & ~own));

        uint64_t file = fileMask(square % 8);
        if (!(file & ownPawns)) {
            sink.add((file & enemyPawns) ? EvalParam::ROOK_SEMI_OPEN_FILE : EvalParam::ROOK_OPEN_FILE, sign);
        }
    }

    uint64_t queens = board.pieceBB(color, Board::QUEEN);
    while (queens) {
        int square = std::countr_zero(queens);
        queens &= queens - 1;
        uint64_t attacks = Board::rookAttackMask(square, all) | Board::bishopAttackMask(square, all);
        sink.add(EvalParam::MOBILITY + 3, sign * std::popcount(attacks & ~own));
    }
}

// Pawn cover in front of the king, on its file and the two adjacent files.
// A pawn one rank ahead is best, two ranks ahead is still something, and a
// file with no friendly pawn at all is an open attack lane. These terms are
// middlegame-only by default (eg = 0): shelter means nothing in a pawn ending.
template <typename Sink>
void Evaluator::walkKingShelter(const Board& board, Color color, int sign, Sink& sink) const {
    uint64_t king = board.pieceBB(color, Board::KING);
    if (!king) return;

    int kingSquare = std::countr_zero(king);
    int kingFile = kingSquare % 8;
    int kingRank = kingSquare / 8;
    int forward = (color == Color::WHITE ? 1 : -1);
    uint64_t ownPawns = board.pieceBB(color, Board::PAWN);

    for (int file = std::max(0, kingFile - 1); file <= std::min(7, kingFile + 1); ++file) {
        uint64_t pawnsOnFile = ownPawns & fileMask(file);
        if (!pawnsOnFile) {
            sink.add(EvalParam::KING_OPEN_FILE, sign);
            continue;
        }

        int closeRank = kingRank + forward;
        int farRank = kingRank + 2 * forward;

        if (closeRank >= 0 && closeRank < 8 && (pawnsOnFile & (1ULL << (closeRank * 8 + file)))) {
            sink.add(EvalParam::SHELTER_CLOSE, sign);
        } else if (farRank >= 0 && farRank < 8 && (pawnsOnFile & (1ULL << (farRank * 8 + file)))) {
            sink.add(EvalParam::SHELTER_FAR, sign);
        }
    }
}

int Evaluator::evaluateTerminal(const Board& board, const Color side_to_move) {
    if (board.isCheckmate(side_to_move)) return -MATE_SCORE;
    return 0;
}

void Evaluator::initializeDefaults() {
    // Compiled defaults: src/evalDefaults.h, generated from a tuned params
    // file by scripts/eval-defaults.ts.
    std::copy(std::begin(EVAL_DEFAULTS), std::end(EVAL_DEFAULTS), params.begin());
    rebuildPieceSquare();
}

void Evaluator::rebuildPieceSquare() {
    using namespace EvalParam;
    for (int piece = 0; piece < 6; ++piece) {
        const EvalScore material = (piece < Board::KING) ? params[MATERIAL + piece] : EvalScore{};
        for (int sq = 0; sq < 64; ++sq) {
            const EvalScore w = params[PST + piece * 64 + sq];
            const EvalScore b = params[PST + piece * 64 + (sq ^ 56)];
            pieceSquare[0][piece][sq] = {material.mg + w.mg, material.eg + w.eg};
            pieceSquare[1][piece][sq] = {-(material.mg + b.mg), -(material.eg + b.eg)};
        }
    }
}

int Evaluator::getParameterCount() const {
    return 2 * EvalParam::COUNT;
}

int Evaluator::getParameter(int index) const {
    if (index < 0 || index >= getParameterCount()) return 0;
    const EvalScore& s = params[index / 2];
    return (index % 2 == 0) ? s.mg : s.eg;
}

void Evaluator::setParameter(int index, int value) {
    if (index < 0 || index >= getParameterCount()) return;
    EvalScore& s = params[index / 2];
    if (index % 2 == 0) s.mg = value; else s.eg = value;
    if (index / 2 < EvalParam::PASSED_PAWN) rebuildPieceSquare();   // material or PST
}

std::string Evaluator::paramsFileHeader() {
    return "# jewkiebot-eval v2 " + std::to_string(2 * EvalParam::COUNT);
}

bool Evaluator::loadParametersFromFile(const std::string& path, std::string* error) {
    auto fail = [&](const std::string& why) {
        if (error) *error = why;
        return false;
    };

    std::ifstream f(path);
    if (!f) return fail("cannot open file");

    std::string header;
    while (std::getline(f, header)) {
        while (!header.empty() && (header.back() == '\r' || header.back() == ' ')) header.pop_back();
        if (!header.empty()) break;
    }
    if (header != paramsFileHeader())
        return fail("eval params version mismatch (expected \"" + paramsFileHeader() + "\"), using defaults");

    const int count = getParameterCount();
    std::vector<int> values;
    values.reserve(count);
    int value;
    while (static_cast<int>(values.size()) < count && (f >> value)) values.push_back(value);
    if (static_cast<int>(values.size()) != count)
        return fail("expected " + std::to_string(count) + " values, read " + std::to_string(values.size()));

    std::string rest;
    if (f >> rest) return fail("unexpected data after " + std::to_string(count) + " values");

    for (int i = 0; i < count; ++i) setParameter(i, values[i]);
    return true;
}

std::string Evaluator::exportParameters() const {
    std::string out = paramsFileHeader() + "\n";
    const int count = getParameterCount();
    for (int i = 0; i < count; ++i) {
        out += std::to_string(getParameter(i));
        out += '\n';
    }
    return out;
}

