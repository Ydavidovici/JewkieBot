#pragma once
#include <array>
#include <vector>
#include <cstdint>
#include <string>
#include <random>
#include <mutex>

#include "move.h"
#include "types.h"

class Board {
public:
    enum PieceIndex {PAWN = 0, KNIGHT, BISHOP, ROOK, QUEEN, KING, PieceTypeCount};

    Board();
    void loadFEN(const std::string& fenString);
    explicit Board(const std::string& fenString) { loadFEN(fenString); }

    std::string toFEN() const;
    std::vector<Move> generatePseudoMoves() const;
    std::vector<Move> generateLegalMoves() const;

    bool makeMove(const Move& move);
    void unmakeMove();
    void makeNullMove();
    void unmakeNullMove();

    void printBoard() const;

    bool inCheck(Color color) const;
    bool hasLegalMoves(Color color) const;
    bool isCheckmate(Color color) const;
    bool isStalemate(Color color) const;
    bool isFiftyMoveDraw() const;
    bool isThreefoldRepetition() const;
    bool isInsufficientMaterial() const;

    uint64_t occupancy(Color color) const;
    uint64_t pieceBB(Color color, PieceIndex pieceIndex) const;
    Color sideToMove() const {return side_to_move;}
    PieceIndex getPieceAt(int square) const;

    uint64_t zobristKey() const {return current_zobrist_key;}

    int fullmoveNumber() const {return fullmove_number;}
    int enPassantSquare() const {return en_passant_square_index;}
    uint8_t castlingRights() const {return castling_rights;}


private:
    std::array<uint64_t, PieceTypeCount> white_bitboards{};
    std::array<uint64_t, PieceTypeCount> black_bitboards{};

    Color side_to_move;
    uint8_t castling_rights{};
    int en_passant_square_index{};
    int halfmove_clock{};
    int fullmove_number{};

    uint64_t current_zobrist_key{};

    static uint64_t piece_keys[12][64];
    static uint64_t en_passant_keys[64];
    static uint64_t castling_keys[16];
    static uint64_t side_key;
    static std::once_flag zobrist_once_flag_;

    struct Undo {
        uint8_t castling_rights;
        int en_passant_square_index;
        int halfmove_clock;
        int fullmove_number;
        uint64_t zobrist_key;
        Move move;
        PieceIndex moved_piece;
        PieceIndex captured_piece;
        bool is_pawn_double_push;
        bool is_castling_move;
        int castling_rook_from_square;
        int castling_rook_to_square;
    };

    std::vector<Undo> move_history;

    static bool inBounds(int squareIndex) {return squareIndex >= 0 && squareIndex < 64;}
    static void setBit(uint64_t& bitboard, int squareIndex) {bitboard |= (1ULL << squareIndex);}
    static void clearBit(uint64_t& bitboard, int squareIndex) {bitboard &= ~(1ULL << squareIndex);}
    static bool testBit(uint64_t bitboard, int squareIndex) {return (bitboard >> squareIndex) & 1ULL;}

    bool isSquareAttacked(int squareIndex, Color attackingColor) const;
    int findKing(Color color) const;
    static uint64_t calculateZobristKey(const Board& board);

    void printFENString() const;
    void printPseudoLegalMoves() const;
    void printLegalMoves() const;
    void printBitboards() const;
    static void printSingleBitboard(uint64_t bitboard, const std::string& label);
};