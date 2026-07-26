#include "evaluator.h"
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

} // namespace

Evaluator::Evaluator() {
    initEvalMasks();
    initializePieceSquareTables();
}

int Evaluator::evaluate(const Board& board, Color sideToMove) const {
    int score = 0;

    // Pawns through queens use the fused value+PST tables; the king is
    // handled separately below so its table can be phase-tapered.
    for (int pieceIndex = 0; pieceIndex < Board::KING; ++pieceIndex) {
        auto piece = static_cast<Board::PieceIndex>(pieceIndex);

        uint64_t whiteBitBoard = board.pieceBB(Color::WHITE, piece);
        while (whiteBitBoard) {
            score += combinedTables[0][pieceIndex][__builtin_ctzll(whiteBitBoard)];
            whiteBitBoard &= whiteBitBoard - 1;
        }

        uint64_t blackBitBoard = board.pieceBB(Color::BLACK, piece);
        while (blackBitBoard) {
            score -= combinedTables[1][pieceIndex][__builtin_ctzll(blackBitBoard)];
            blackBitBoard &= blackBitBoard - 1;
        }
    }

    // Tapered king evaluation: blend the middlegame table (castled safety)
    // into the endgame table (centralization) as material comes off.
    // Phase weights: N=1, B=1, R=2, Q=4; 24 = all pieces on the board.
    constexpr int PHASE_MAX = 24;
    int phase =
        std::popcount(board.pieceBB(Color::WHITE, Board::KNIGHT)) +
        std::popcount(board.pieceBB(Color::BLACK, Board::KNIGHT)) +
        std::popcount(board.pieceBB(Color::WHITE, Board::BISHOP)) +
        std::popcount(board.pieceBB(Color::BLACK, Board::BISHOP)) +
        2 * std::popcount(board.pieceBB(Color::WHITE, Board::ROOK)) +
        2 * std::popcount(board.pieceBB(Color::BLACK, Board::ROOK)) +
        4 * std::popcount(board.pieceBB(Color::WHITE, Board::QUEEN)) +
        4 * std::popcount(board.pieceBB(Color::BLACK, Board::QUEEN));
    phase = std::min(phase, PHASE_MAX);

    int kingValue = pieceValues[Board::KING];

    uint64_t whiteKing = board.pieceBB(Color::WHITE, Board::KING);
    while (whiteKing) {
        int square = __builtin_ctzll(whiteKing);
        int pst = (whiteKingTableMG[square] * phase +
                   whiteKingTableEG[square] * (PHASE_MAX - phase)) / PHASE_MAX;
        score += kingValue + pst;
        whiteKing &= whiteKing - 1;
    }

    uint64_t blackKing = board.pieceBB(Color::BLACK, Board::KING);
    while (blackKing) {
        int square = __builtin_ctzll(blackKing);
        int pst = (blackKingTableMG[square] * phase +
                   blackKingTableEG[square] * (PHASE_MAX - phase)) / PHASE_MAX;
        score -= kingValue + pst;
        blackKing &= blackKing - 1;
    }

    // Structural heuristics: pawn structure (doubled/isolated/passed) and
    // piece activity (mobility, bishop pair, rooks on open files).
    score += pawnStructureScore(board, Color::WHITE) - pawnStructureScore(board, Color::BLACK);
    score += pieceActivityScore(board, Color::WHITE) - pieceActivityScore(board, Color::BLACK);

    // King shelter only matters while the opponent still has attacking
    // material, so it fades out with the phase — in the endgame the tapered
    // king PST above takes over and pulls the king to the center instead.
    score += (kingShelterScore(board, Color::WHITE) - kingShelterScore(board, Color::BLACK)) * phase / PHASE_MAX;

    return (sideToMove == Color::WHITE ? score : -score);
}

// Doubled and isolated pawns are penalized; passed pawns are rewarded more
// the closer they get to promotion.
int Evaluator::pawnStructureScore(const Board& board, Color color) const {
    Color enemy = (color == Color::WHITE ? Color::BLACK : Color::WHITE);
    uint64_t ownPawns = board.pieceBB(color, Board::PAWN);
    uint64_t enemyPawns = board.pieceBB(enemy, Board::PAWN);

    int score = 0;

    for (int file = 0; file < 8; ++file) {
        int pawnsOnFile = std::popcount(ownPawns & fileMask(file));
        if (pawnsOnFile > 1) {
            score -= doubledPawnPenalty * (pawnsOnFile - 1);
        }
    }

    uint64_t scan = ownPawns;
    while (scan) {
        int square = std::countr_zero(scan);
        scan &= scan - 1;
        int file = square % 8;

        if (!(ownPawns & adjacentFilesMask(file))) {
            score -= isolatedPawnPenalty;
        }

        if (!(passed_pawn_masks[static_cast<int>(color)][square] & enemyPawns)) {
            int relativeRank = (color == Color::WHITE ? square / 8 : 7 - square / 8);
            score += passedPawnBonus[relativeRank];
        }
    }

    return score;
}

// "Passive pieces" in numbers: each knight/bishop/rook/queen earns a small
// bonus per square it can reach, so pieces stuck behind their own pawns
// score low. Adds the bishop pair and rooks on (semi-)open files.
int Evaluator::pieceActivityScore(const Board& board, Color color) const {
    Color enemy = (color == Color::WHITE ? Color::BLACK : Color::WHITE);
    uint64_t own = board.occupancy(color);
    uint64_t all = own | board.occupancy(enemy);
    uint64_t ownPawns = board.pieceBB(color, Board::PAWN);
    uint64_t enemyPawns = board.pieceBB(enemy, Board::PAWN);

    int score = 0;

    if (std::popcount(board.pieceBB(color, Board::BISHOP)) >= 2) {
        score += bishopPairBonus;
    }

    uint64_t knights = board.pieceBB(color, Board::KNIGHT);
    while (knights) {
        int square = std::countr_zero(knights);
        knights &= knights - 1;
        score += mobilityWeights[0] * std::popcount(Board::knightAttackMask(square) & ~own);
    }

    uint64_t bishops = board.pieceBB(color, Board::BISHOP);
    while (bishops) {
        int square = std::countr_zero(bishops);
        bishops &= bishops - 1;
        score += mobilityWeights[1] * std::popcount(Board::bishopAttackMask(square, all) & ~own);
    }

    uint64_t rooks = board.pieceBB(color, Board::ROOK);
    while (rooks) {
        int square = std::countr_zero(rooks);
        rooks &= rooks - 1;
        score += mobilityWeights[2] * std::popcount(Board::rookAttackMask(square, all) & ~own);

        uint64_t file = fileMask(square % 8);
        if (!(file & ownPawns)) {
            score += (file & enemyPawns) ? rookSemiOpenFileBonus : rookOpenFileBonus;
        }
    }

    uint64_t queens = board.pieceBB(color, Board::QUEEN);
    while (queens) {
        int square = std::countr_zero(queens);
        queens &= queens - 1;
        uint64_t attacks = Board::rookAttackMask(square, all) | Board::bishopAttackMask(square, all);
        score += mobilityWeights[3] * std::popcount(attacks & ~own);
    }

    return score;
}

// Pawn cover in front of the king, on its file and the two adjacent files.
// A pawn one rank ahead is best, two ranks ahead is still something, and a
// file with no friendly pawn at all is an open attack lane. The caller
// scales this by game phase: shelter means nothing in a pawn ending.
int Evaluator::kingShelterScore(const Board& board, Color color) const {
    uint64_t king = board.pieceBB(color, Board::KING);
    if (!king) return 0;

    int kingSquare = std::countr_zero(king);
    int kingFile = kingSquare % 8;
    int kingRank = kingSquare / 8;
    int forward = (color == Color::WHITE ? 1 : -1);
    uint64_t ownPawns = board.pieceBB(color, Board::PAWN);

    int score = 0;

    for (int file = std::max(0, kingFile - 1); file <= std::min(7, kingFile + 1); ++file) {
        uint64_t pawnsOnFile = ownPawns & fileMask(file);
        if (!pawnsOnFile) {
            score -= kingOpenFilePenalty;
            continue;
        }

        int closeRank = kingRank + forward;
        int farRank = kingRank + 2 * forward;

        if (closeRank >= 0 && closeRank < 8 && (pawnsOnFile & (1ULL << (closeRank * 8 + file)))) {
            score += shelterCloseBonus;
        } else if (farRank >= 0 && farRank < 8 && (pawnsOnFile & (1ULL << (farRank * 8 + file)))) {
            score += shelterFarBonus;
        }
    }

    return score;
}

int Evaluator::evaluateTerminal(const Board& board, const Color side_to_move) {
    if (board.isCheckmate(side_to_move)) return -MATE_SCORE;
    return 0;
}

int Evaluator::evaluateMaterial(const Board& board) const {
    auto countSetBits = [](const uint64_t bits) {return __builtin_popcountll(bits);};

    int score = 0;
    for (int pt = 0; pt < PST_COUNT; ++pt) {
        const int whiteCount = countSetBits(board.pieceBB(Color::WHITE, static_cast<Board::PieceIndex>(pt)));
        const int blackCount = countSetBits(board.pieceBB(Color::BLACK, static_cast<Board::PieceIndex>(pt)));

        score += pieceValues[pt] * (whiteCount - blackCount);
    }
    return score;
}

int Evaluator::evaluatePositional(const Board& board) const {
    int score = 0;

    auto applyPST = [&](uint64_t bitboard, const std::array<int, 64>& table, const int sign) {
        while (bitboard) {
            int square = __builtin_ctzll(bitboard);
            score += sign * table[square];
            bitboard &= bitboard - 1;
        }
    };

    applyPST(board.pieceBB(Color::WHITE, Board::PAWN), whitePawnTable, 1);
    applyPST(board.pieceBB(Color::WHITE, Board::KNIGHT), whiteKnightTable, 1);
    applyPST(board.pieceBB(Color::WHITE, Board::BISHOP), whiteBishopTable, 1);
    applyPST(board.pieceBB(Color::WHITE, Board::ROOK), whiteRookTable, 1);
    applyPST(board.pieceBB(Color::WHITE, Board::QUEEN), whiteQueenTable, 1);
    applyPST(board.pieceBB(Color::WHITE, Board::KING), whiteKingTableMG, 1);

    applyPST(board.pieceBB(Color::BLACK, Board::PAWN), blackPawnTable, -1);
    applyPST(board.pieceBB(Color::BLACK, Board::KNIGHT), blackKnightTable, -1);
    applyPST(board.pieceBB(Color::BLACK, Board::BISHOP), blackBishopTable, -1);
    applyPST(board.pieceBB(Color::BLACK, Board::ROOK), blackRookTable, -1);
    applyPST(board.pieceBB(Color::BLACK, Board::QUEEN), blackQueenTable, -1);
    applyPST(board.pieceBB(Color::BLACK, Board::KING), blackKingTableMG, -1);

    return score;
}

void Evaluator::initializePieceSquareTables() {
    // -----------------------------------------------------------
    // 1. AGGRESSIVE PAWN TABLE
    // Logic: Rank 2 is 0. Rank 4 (center) is highly rewarded.
    // Rank 7 is massive (promotion threat).
    // -----------------------------------------------------------
    whitePawnTable = {
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, -20, -20, 10, 10, 5,
        5, -5, 0, 5, 5, 0, -5, 5,
        0, 0, 10, 40, 40, 10, 0, 0, // Rank 4: +40 for e4/d4 (was 20)
        5, 5, 20, 60, 60, 20, 5, 5, // Rank 5: +60 for e5/d5
        10, 10, 30, 80, 80, 30, 10, 10, // Rank 6: Crushing
        50, 50, 50, 50, 50, 50, 50, 50,
        0, 0, 0, 0, 0, 0, 0, 0
    };

    whiteKnightTable = {
        -50, -40, -30, -30, -30, -30, -40, -50,
        -40, -20, 0, 0, 0, 0, -20, -40,
        -30, 0, 10, 15, 15, 10, 0, -30,
        -30, 5, 15, 20, 20, 15, 5, -30,
        -30, 0, 15, 20, 20, 15, 0, -30,
        -30, 5, 10, 15, 15, 10, 5, -30,
        -40, -20, 0, 5, 5, 0, -20, -40,
        -50, -40, -30, -30, -30, -30, -40, -50
    };

    whiteBishopTable = {
        -20, -10, -10, -10, -10, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 10, 10, 5, 0, -10,
        -10, 5, 5, 10, 10, 5, 5, -10,
        -10, 0, 10, 10, 10, 10, 0, -10,
        -10, 10, 10, 10, 10, 10, 10, -10,
        -10, 5, 0, 0, 0, 0, 5, -10,
        -20, -10, -10, -10, -10, -10, -10, -20
    };

    // All tables are indexed square 0 = a1, so the FIRST source row is rank 1.
    // (The rook and king tables used to be pasted rank-8-first, which
    // inverted them: rooks were drawn to rank 2 instead of the 7th, and the
    // king was rewarded for marching up the board instead of castling.)
    whiteRookTable = {
        0, 0, 0, 5, 5, 0, 0, 0,          // rank 1: centralized castled rook
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        5, 10, 10, 10, 10, 10, 10, 5,    // rank 7: rook on the seventh
        0, 0, 0, 0, 0, 0, 0, 0
    };

    whiteQueenTable = {
        -20, -10, -10, -5, -5, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 5, 5, 5, 0, -10,
        -5, 0, 5, 5, 5, 5, 0, -5,
        0, 0, 5, 5, 5, 5, 0, -5,
        -10, 5, 5, 5, 5, 5, 0, -10,
        -10, 0, 5, 0, 0, 0, 0, -10,
        -20, -10, -10, -5, -5, -10, -10, -20
    };

    // Middlegame: stay castled behind the pawns; the center is dangerous.
    whiteKingTableMG = {
        20, 30, 10, 0, 0, 10, 30, 20,    // rank 1: castled corners are safest
        20, 20, 0, 0, 0, 0, 20, 20,
        -10, -20, -20, -20, -20, -20, -20, -10,
        -20, -30, -30, -40, -40, -30, -30, -20,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30
    };

    // Endgame: the king is a fighting piece — centralize it.
    whiteKingTableEG = {
        -50, -30, -30, -30, -30, -30, -30, -50,
        -30, -30, 0, 0, 0, 0, -30, -30,
        -30, -10, 20, 30, 30, 20, -10, -30,
        -30, -10, 30, 40, 40, 30, -10, -30,
        -30, -10, 30, 40, 40, 30, -10, -30,
        -30, -10, 20, 30, 30, 20, -10, -30,
        -30, -20, -10, 0, 0, -10, -20, -30,
        -50, -40, -30, -20, -20, -30, -40, -50
    };

    updateBlackTables();
}

// Parameter layout for Texel-style tuning:
//   [0..5]      piece values
//   [6..389]    6 PSTs of 64 squares (P, N, B, R, Q, K_MG)
//   [390..401]  scalar heuristic weights (see scalarParams below)
//   [402..409]  passed-pawn bonus by relative rank
int Evaluator::getParameterCount() const {
    return 6 + 6 * 64 + SCALAR_PARAM_COUNT + 8;
}

// The scalar heuristic weights in a fixed order shared by get/setParameter.
static constexpr int SCALAR_PARAM_COUNT_CHECK = 12;
int* Evaluator::scalarParams(int index) {
    int* params[SCALAR_PARAM_COUNT] = {
        &doubledPawnPenalty, &isolatedPawnPenalty, &bishopPairBonus,
        &rookOpenFileBonus, &rookSemiOpenFileBonus,
        &mobilityWeights[0], &mobilityWeights[1], &mobilityWeights[2], &mobilityWeights[3],
        &shelterCloseBonus, &shelterFarBonus, &kingOpenFilePenalty,
    };
    static_assert(SCALAR_PARAM_COUNT == SCALAR_PARAM_COUNT_CHECK, "keep layout comment in sync");
    return (index >= 0 && index < SCALAR_PARAM_COUNT) ? params[index] : nullptr;
}

int Evaluator::getParameter(int index) const {
    if (index < 6) return pieceValues[index];
    index -= 6;
    if (index < 64) return whitePawnTable[index];
    index -= 64;
    if (index < 64) return whiteKnightTable[index];
    index -= 64;
    if (index < 64) return whiteBishopTable[index];
    index -= 64;
    if (index < 64) return whiteRookTable[index];
    index -= 64;
    if (index < 64) return whiteQueenTable[index];
    index -= 64;
    if (index < 64) return whiteKingTableMG[index];
    index -= 64;
    if (index < SCALAR_PARAM_COUNT) {
        return *const_cast<Evaluator*>(this)->scalarParams(index);
    }
    index -= SCALAR_PARAM_COUNT;
    if (index < 8) return passedPawnBonus[index];
    return 0;
}

// used for perf testing and tuning
void Evaluator::setParameter(int index, int value) {
    if (index < 6) { pieceValues[index] = value; return; }
    index -= 6;
    if (index < 64) { whitePawnTable[index] = value; return; }
    index -= 64;
    if (index < 64) { whiteKnightTable[index] = value; return; }
    index -= 64;
    if (index < 64) { whiteBishopTable[index] = value; return; }
    index -= 64;
    if (index < 64) { whiteRookTable[index] = value; return; }
    index -= 64;
    if (index < 64) { whiteQueenTable[index] = value; return; }
    index -= 64;
    if (index < 64) { whiteKingTableMG[index] = value; return; }
    index -= 64;
    if (index < SCALAR_PARAM_COUNT) { *scalarParams(index) = value; return; }
    index -= SCALAR_PARAM_COUNT;
    if (index < 8) { passedPawnBonus[index] = value; return; }
}

bool Evaluator::loadParametersFromFile(const std::string& path) {
    std::ifstream f(path);
    if (!f) return false;

    const int count = getParameterCount();
    int index = 0;
    int value;
    // Tolerant of any whitespace layout (one per line, or space-separated).
    // Extra values past the known count are ignored; a short file applies its
    // prefix and leaves the rest at their current values.
    while (index < count && (f >> value)) {
        setParameter(index, value);
        ++index;
    }

    updateBlackTables();  // rebuild mirrored black + combined tables from the new values
    return index > 0;
}

std::string Evaluator::exportParameters() const {
    std::string out;
    const int count = getParameterCount();
    for (int i = 0; i < count; ++i) {
        out += std::to_string(getParameter(i));
        out += '\n';
    }
    return out;
}

namespace {
    // Texel sigmoid with the conventional scaling constant (K≈400 in cp units).
    double tuneSigmoid(double eval) { return 1.0 / (1.0 + std::pow(10.0, -eval / 400.0)); }

    struct TuningEntry { Board board; double result; };
}

bool Evaluator::tuneFromDataset(const std::string& datasetPath, const std::string& outputPath,
                                int maxEpochs, const std::function<void(int, double)>& onEpoch) {
    std::ifstream file(datasetPath);
    if (!file.is_open()) return false;

    std::vector<TuningEntry> dataset;
    std::string line;
    while (std::getline(file, line)) {
        if (line.empty()) continue;
        // Each line: "<fen fields> c9 \"<result>\"".
        size_t c9 = line.find("c9 \"");
        if (c9 == std::string::npos) continue;

        std::string fen = line.substr(0, c9 - 1);
        size_t rs = c9 + 4;
        size_t re = line.find('"', rs);
        std::string result_str = line.substr(rs, re - rs);

        double result = 0.5;
        if (result_str == "1.0" || result_str == "1-0") result = 1.0;
        else if (result_str == "0.0" || result_str == "0-1") result = 0.0;

        Board b;
        b.loadFEN(fen);
        dataset.push_back({b, result});
    }
    if (dataset.empty()) return false;

    auto mse = [&]() {
        double total = 0.0;
        for (const auto& e : dataset) {
            int ev = evaluate(e.board, e.board.sideToMove());
            if (e.board.sideToMove() == Color::BLACK) ev = -ev;  // to White's perspective
            double diff = e.result - tuneSigmoid(static_cast<double>(ev));
            total += diff * diff;
        }
        return total / static_cast<double>(dataset.size());
    };

    const int count = getParameterCount();
    double best = mse();
    if (onEpoch) onEpoch(0, best);

    for (int epoch = 1; epoch <= maxEpochs; ++epoch) {
        bool improved = false;
        for (int p = 0; p < count; ++p) {
            const int orig = getParameter(p);

            setParameter(p, orig + 1); updateBlackTables();
            const double plus = mse();
            setParameter(p, orig - 1); updateBlackTables();
            const double minus = mse();

            if (plus < best && plus <= minus) {
                setParameter(p, orig + 1); updateBlackTables();
                best = plus; improved = true;
            } else if (minus < best) {
                setParameter(p, orig - 1); updateBlackTables();
                best = minus; improved = true;
            } else {
                setParameter(p, orig); updateBlackTables();  // restore
            }
        }
        if (onEpoch) onEpoch(epoch, best);
        if (!improved) break;  // converged
    }

    std::ofstream out(outputPath);
    if (!out.is_open()) return false;
    for (int i = 0; i < count; ++i) out << getParameter(i) << "\n";
    return true;
}

void Evaluator::updateBlackTables() {
    auto mirror = [](const std::array<int, 64>& white, std::array<int, 64>& black) {
        for (int i = 0; i < 64; ++i) {
            black[i] = white[i ^ 56];
        }
    };

    mirror(whitePawnTable, blackPawnTable);
    mirror(whiteKnightTable, blackKnightTable);
    mirror(whiteBishopTable, blackBishopTable);
    mirror(whiteRookTable, blackRookTable);
    mirror(whiteQueenTable, blackQueenTable);
    mirror(whiteKingTableMG, blackKingTableMG);
    mirror(whiteKingTableEG, blackKingTableEG);

    const std::array<int, 64>* whiteTables[PST_COUNT] = {
        &whitePawnTable, &whiteKnightTable, &whiteBishopTable,
        &whiteRookTable, &whiteQueenTable, &whiteKingTableMG
    };
    const std::array<int, 64>* blackTables[PST_COUNT] = {
        &blackPawnTable, &blackKnightTable, &blackBishopTable,
        &blackRookTable, &blackQueenTable, &blackKingTableMG
    };

    for (int pieceIndex = 0; pieceIndex < PST_COUNT; ++pieceIndex) {
        for (int squareIndex = 0; squareIndex < 64; ++squareIndex) {
            combinedTables[0][pieceIndex][squareIndex] = pieceValues[pieceIndex] + (*whiteTables[pieceIndex])[squareIndex];
            combinedTables[1][pieceIndex][squareIndex] = pieceValues[pieceIndex] + (*blackTables[pieceIndex])[squareIndex];
        }
    }
}