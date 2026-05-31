#include "evaluator.h"
#include <algorithm>

static constexpr int MATE_SCORE = 100000;

Evaluator::Evaluator() {
    initializePieceSquareTables();
}

int Evaluator::evaluate(const Board& board, Color sideToMove) const {
    int score = 0;

    auto evalPieceType = [&](const std::vector<int>& whiteTable, const std::vector<int>& blackTable, Board::PieceIndex pieceTable) {
        int value = pieceValues[pieceTable];

        uint64_t whiteBitBoard = board.pieceBB(Color::WHITE, pieceTable);
        while (whiteBitBoard) {
            int square = __builtin_ctzll(whiteBitBoard);
            score += (value + whiteTable[square]);
            whiteBitBoard &= whiteBitBoard - 1;
        }

        uint64_t blackBitBoard = board.pieceBB(Color::BLACK, pieceTable);
        while (blackBitBoard) {
            int square = __builtin_ctzll(blackBitBoard);
            score -= (value + blackTable[square]);
            blackBitBoard &= blackBitBoard - 1;
        }
    };

    evalPieceType(whitePawnTable, blackPawnTable, Board::PAWN);
    evalPieceType(whiteKnightTable, blackKnightTable, Board::KNIGHT);
    evalPieceType(whiteBishopTable, blackBishopTable, Board::BISHOP);
    evalPieceType(whiteRookTable, blackRookTable, Board::ROOK);
    evalPieceType(whiteQueenTable, blackQueenTable, Board::QUEEN);
    evalPieceType(whiteKingTableMG, blackKingTableMG, Board::KING);

    return (sideToMove == Color::WHITE ? score : -score);
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

    auto applyPST = [&](uint64_t bitboard, const std::vector<int>& table, const int sign) {
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

    whiteRookTable = {
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, 10, 10, 10, 10, 5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        0, 0, 0, 5, 5, 0, 0, 0
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

    // Castling incentives
    whiteKingTableMG = {
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -20, -30, -30, -40, -40, -30, -30, -20,
        -10, -20, -20, -20, -20, -20, -20, -10,
        20, 20, 0, 0, 0, 0, 20, 20,
        20, 30, 10, 0, 0, 10, 30, 20
    };

    whiteKingTableEG = {
        -50, -40, -30, -20, -20, -30, -40, -50,
        -30, -20, -10, 0, 0, -10, -20, -30,
        -30, -10, 20, 30, 30, 20, -10, -30,
        -30, -10, 30, 40, 40, 30, -10, -30,
        -30, -10, 30, 40, 40, 30, -10, -30,
        -30, -10, 20, 30, 30, 20, -10, -30,
        -30, -30, 0, 0, 0, 0, -30, -30,
        -50, -30, -30, -30, -30, -30, -30, -50
    };

    updateBlackTables();
}

int Evaluator::getParameterCount() const {
    return 6 + 6 * 64; // 6 piece values + 6 tables (P, N, B, R, Q, K_MG)
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
    return 0;
}

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
}

void Evaluator::updateBlackTables() {
    auto mirror = [](const std::vector<int>& white, std::vector<int>& black) {
        black.resize(64);
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
}