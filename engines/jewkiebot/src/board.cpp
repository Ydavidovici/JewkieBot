#include "board.h"

#include <sstream>
#include <cassert>
#include <cctype>
#include <cmath>
#include <iostream>
#include <random>
#include <bit>

uint64_t Board::piece_keys[12][64];
uint64_t Board::en_passant_keys[64];
uint64_t Board::castling_keys[16];
uint64_t Board::side_key;
std::once_flag Board::zobrist_once_flag_;

namespace {
    // Precomputed attack tables. Leaper attacks are direct lookups; slider
    // attacks use the classical ray approach: take the full ray from the
    // square, find the first blocker, and mask off everything behind it.
    enum RayDirection {
        RAY_NORTH = 0, RAY_SOUTH, RAY_EAST, RAY_WEST,
        RAY_NORTHEAST, RAY_NORTHWEST, RAY_SOUTHEAST, RAY_SOUTHWEST
    };

    struct AttackTables {
        uint64_t knight_attacks[64];
        uint64_t king_attacks[64];
        uint64_t pawn_attacks[2][64]; // [color][square]: squares a pawn of that color attacks from square
        uint64_t ray_attacks[8][64];
    };

    AttackTables buildAttackTables() {
        AttackTables tables{};

        auto isOnBoard = [](int file, int rank) {return file >= 0 && file < 8 && rank >= 0 && rank < 8;};

        static const int knight_deltas[8][2] = {{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}};
        static const int ray_deltas[8][2] = {{0, 1}, {0, -1}, {1, 0}, {-1, 0}, {1, 1}, {-1, 1}, {1, -1}, {-1, -1}};

        for (int square = 0; square < 64; ++square) {
            int file = square & 7;
            int rank = square >> 3;

            for (const auto& knight_delta : knight_deltas) {
                int file_delta = knight_delta[0];
                int rank_delta = knight_delta[1];
                if (isOnBoard(file + file_delta, rank + rank_delta))
                    tables.knight_attacks[square] |= 1ULL << ((rank + rank_delta) * 8 + file + file_delta);
            }

            for (int file_delta = -1; file_delta <= 1; ++file_delta)
                for (int rank_delta = -1; rank_delta <= 1; ++rank_delta)
                    if ((file_delta || rank_delta) && isOnBoard(file + file_delta, rank + rank_delta))
                        tables.king_attacks[square] |= 1ULL << ((rank + rank_delta) * 8 + file + file_delta);

            if (isOnBoard(file - 1, rank + 1)) tables.pawn_attacks[0][square] |= 1ULL << ((rank + 1) * 8 + file - 1);
            if (isOnBoard(file + 1, rank + 1)) tables.pawn_attacks[0][square] |= 1ULL << ((rank + 1) * 8 + file + 1);
            if (isOnBoard(file - 1, rank - 1)) tables.pawn_attacks[1][square] |= 1ULL << ((rank - 1) * 8 + file - 1);
            if (isOnBoard(file + 1, rank - 1)) tables.pawn_attacks[1][square] |= 1ULL << ((rank - 1) * 8 + file + 1);

            for (int direction_index = 0; direction_index < 8; ++direction_index) {
                int current_file = file + ray_deltas[direction_index][0];
                int current_rank = rank + ray_deltas[direction_index][1];
                while (isOnBoard(current_file, current_rank)) {
                    tables.ray_attacks[direction_index][square] |= 1ULL << (current_rank * 8 + current_file);
                    current_file += ray_deltas[direction_index][0];
                    current_rank += ray_deltas[direction_index][1];
                }
            }
        }
        return tables;
    }

    const AttackTables ATTACK_TABLES = buildAttackTables();

    // Rays toward higher square indices scan for the lowest blocker bit,
    // rays toward lower indices for the highest.
    inline uint64_t rayAttacks(int direction, int square, uint64_t occupancy) {
        uint64_t attacks = ATTACK_TABLES.ray_attacks[direction][square];
        uint64_t blockers = attacks & occupancy;
        if (blockers) {
            int first_blocker_square =
                (direction == RAY_NORTH || direction == RAY_EAST ||
                 direction == RAY_NORTHEAST || direction == RAY_NORTHWEST)
                    ? std::countr_zero(blockers)
                    : 63 - std::countl_zero(blockers);
            attacks ^= ATTACK_TABLES.ray_attacks[direction][first_blocker_square];
        }
        return attacks;
    }

    inline uint64_t rookAttacks(int square, uint64_t occupancy) {
        return rayAttacks(RAY_NORTH, square, occupancy) | rayAttacks(RAY_SOUTH, square, occupancy) |
            rayAttacks(RAY_EAST, square, occupancy) | rayAttacks(RAY_WEST, square, occupancy);
    }

    inline uint64_t bishopAttacks(int square, uint64_t occupancy) {
        return rayAttacks(RAY_NORTHEAST, square, occupancy) | rayAttacks(RAY_NORTHWEST, square, occupancy) |
            rayAttacks(RAY_SOUTHEAST, square, occupancy) | rayAttacks(RAY_SOUTHWEST, square, occupancy);
    }
}

// Zobrist key init, shared by every constructor: a Board built directly from
// a FEN string must get initialized keys too, not just the default Board.
// (The attack tables above are namespace-scope constants and need no call.)
void Board::initStaticTables() {
    std::call_once(zobrist_once_flag_, []() {
        std::mt19937_64 rng(123456789);
        std::uniform_int_distribution<uint64_t> dist;

        for (int p = 0; p < 12; ++p) {
            for (int sq = 0; sq < 64; ++sq) {
                piece_keys[p][sq] = dist(rng);
            }
        }

        for (int sq = 0; sq < 64; ++sq) {
            en_passant_keys[sq] = dist(rng);
        }

        for (int c = 0; c < 16; ++c) {
            castling_keys[c] = dist(rng);
        }

        side_key = dist(rng);
    });
}

Board::Board() {
    initStaticTables();

    white_bitboards.fill(0);
    black_bitboards.fill(0);

    white_bitboards[PAWN] = 0x000000000000FF00ULL;
    white_bitboards[KNIGHT] = 0x0000000000000042ULL;
    white_bitboards[BISHOP] = 0x0000000000000024ULL;
    white_bitboards[ROOK] = 0x0000000000000081ULL;
    white_bitboards[QUEEN] = 0x0000000000000008ULL;
    white_bitboards[KING] = 0x0000000000000010ULL;

    black_bitboards[PAWN] = 0x00FF000000000000ULL;
    black_bitboards[KNIGHT] = 0x4200000000000000ULL;
    black_bitboards[BISHOP] = 0x2400000000000000ULL;
    black_bitboards[ROOK] = 0x8100000000000000ULL;
    black_bitboards[QUEEN] = 0x0800000000000000ULL;
    black_bitboards[KING] = 0x1000000000000000ULL;

    side_to_move = Color::WHITE;
    castling_rights = 0b1111;
    en_passant_square_index = -1;
    halfmove_clock = 0;
    fullmove_number = 1;

    move_history.clear();
    move_history.reserve(256);

    rebuildDerived();
    current_zobrist_key = calculateZobristKey(*this);
}

void Board::rebuildDerived() {
    occupancy_[0] = 0;
    occupancy_[1] = 0;
    mailbox_.fill(PieceTypeCount);

    for (int piece_type_index = 0; piece_type_index < PieceTypeCount; ++piece_type_index) {
        occupancy_[0] |= white_bitboards[piece_type_index];
        occupancy_[1] |= black_bitboards[piece_type_index];

        uint64_t piece_bitboard = white_bitboards[piece_type_index] | black_bitboards[piece_type_index];
        while (piece_bitboard) {
            int square_index = std::countr_zero(piece_bitboard);
            piece_bitboard &= piece_bitboard - 1;
            mailbox_[square_index] = static_cast<uint8_t>(piece_type_index);
        }
    }
}

uint64_t Board::calculateZobristKey(const Board& board) {
    uint64_t key = 0;

    const std::array<uint64_t, PieceTypeCount>* bitboards[2] = {
        &board.white_bitboards,
        &board.black_bitboards
    };

    for (int color = 0; color < 2; ++color) {
        const int offset = color * 6;
        for (int p = 0; p < PieceTypeCount; ++p) {
            uint64_t bb = (*bitboards[color])[p];
            while (bb) {
                int sq = std::countr_zero(bb);
                bb &= bb - 1;
                key ^= piece_keys[p + offset][sq];
            }
        }
    }

    if (board.en_passant_square_index != -1) {
        key ^= en_passant_keys[board.en_passant_square_index];
    }

    key ^= castling_keys[board.castling_rights];

    if (board.side_to_move == Color::BLACK) {
        key ^= side_key;
    }

    return key;
}

void Board::loadFEN(const std::string& fenString) {
    white_bitboards.fill(0);
    black_bitboards.fill(0);

    std::istringstream fen_stream(fenString);
    std::string placement_field;
    std::string side_to_move_field;
    std::string castling_rights_field;
    std::string en_passant_field;

    // extract FEN
    // e.g. rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
    fen_stream >> placement_field >> side_to_move_field >> castling_rights_field >> en_passant_field >> halfmove_clock >> fullmove_number;

    int rank_index = 7;
    int file_index = 0;

    // load board state into memory
    for (char piece_character : placement_field) {
        if (piece_character == '/') {
            --rank_index;
            file_index = 0;
            continue;
        }

        if (std::isdigit(static_cast<unsigned char>(piece_character))) {
            // get the actual int number
            file_index += piece_character - '0';
            continue;
        }

        int square_index = rank_index * 8 + file_index;

        ++file_index;

        switch (piece_character) {
        case 'P': setBit(white_bitboards[PAWN], square_index);
            break;
        case 'N': setBit(white_bitboards[KNIGHT], square_index);
            break;
        case 'B': setBit(white_bitboards[BISHOP], square_index);
            break;
        case 'R': setBit(white_bitboards[ROOK], square_index);
            break;
        case 'Q': setBit(white_bitboards[QUEEN], square_index);
            break;
        case 'K': setBit(white_bitboards[KING], square_index);
            break;
        case 'p': setBit(black_bitboards[PAWN], square_index);
            break;
        case 'n': setBit(black_bitboards[KNIGHT], square_index);
            break;
        case 'b': setBit(black_bitboards[BISHOP], square_index);
            break;
        case 'r': setBit(black_bitboards[ROOK], square_index);
            break;
        case 'q': setBit(black_bitboards[QUEEN], square_index);
            break;
        case 'k': setBit(black_bitboards[KING], square_index);
            break;
        }
    }

    side_to_move = (side_to_move_field == "w" ? Color::WHITE : Color::BLACK);

    castling_rights = 0;

    if (castling_rights_field.find('K') != std::string::npos) castling_rights |= 0b1;
    if (castling_rights_field.find('Q') != std::string::npos) castling_rights |= 0b10;
    if (castling_rights_field.find('k') != std::string::npos) castling_rights |= 0b100;
    if (castling_rights_field.find('q') != std::string::npos) castling_rights |= 0b1000;

    if (en_passant_field != "-") {
        int file_index_ep = en_passant_field[0] - 'a';
        int rank_index_ep = en_passant_field[1] - '1';
        en_passant_square_index = rank_index_ep * 8 + file_index_ep;
    }
    else {
        en_passant_square_index = -1;
    }

    move_history.clear();
    move_history.reserve(256);

    rebuildDerived();
    current_zobrist_key = calculateZobristKey(*this);
}

std::string Board::toFEN() const {
    std::string fen_string;

    for (int rank_index = 7; rank_index >= 0; --rank_index) {
        int empty_count = 0;

        for (int file_index = 0; file_index < 8; ++file_index) {
            int square_index = rank_index * 8 + file_index;
            char piece_character = 0;

            for (int piece_type_index = 0; piece_type_index < PieceTypeCount; ++piece_type_index) {
                if (testBit(white_bitboards[piece_type_index], square_index)) {
                    piece_character = "PNBRQK"[piece_type_index];
                    break;
                }
                if (testBit(black_bitboards[piece_type_index], square_index)) {
                    piece_character = "pnbrqk"[piece_type_index];
                    break;
                }
            }

            if (piece_character) {
                if (empty_count) {
                    fen_string += char('0' + empty_count);
                    empty_count = 0;
                }
                fen_string += piece_character;
            }
            else {
                ++empty_count;
            }
        }

        if (empty_count)
            fen_string += char('0' + empty_count);
        if (rank_index)
            fen_string += '/';
    }

    fen_string += ' ';
    fen_string += (side_to_move == Color::WHITE ? 'w' : 'b');

    fen_string += ' ';
    std::string castling_string;
    if (castling_rights & 0b0001) castling_string += 'K';
    if (castling_rights & 0b0010) castling_string += 'Q';
    if (castling_rights & 0b0100) castling_string += 'k';
    if (castling_rights & 0b1000) castling_string += 'q';
    fen_string += (castling_string.empty() ? "-" : castling_string);

    fen_string += ' ';
    if (en_passant_square_index != -1) {
        int file_index_ep = en_passant_square_index % 8;
        int rank_index_ep = en_passant_square_index / 8;
        fen_string += char('a' + file_index_ep);
        fen_string += char('1' + rank_index_ep);
    }
    else {
        fen_string += '-';
    }

    fen_string += ' ' + std::to_string(halfmove_clock);
    fen_string += ' ' + std::to_string(fullmove_number);

    return fen_string;
}

uint64_t Board::pieceBB(Color color, PieceIndex pieceIndex) const {
    return (color == Color::WHITE ? white_bitboards[pieceIndex] : black_bitboards[pieceIndex]);
}

void Board::generatePseudoMoves(MoveList& out) const {
    out.clear();

    Color us_color = side_to_move;
    const int own_color_index = (us_color == Color::WHITE ? 0 : 1);
    const auto& own_bitboards = (us_color == Color::WHITE ? white_bitboards : black_bitboards);

    uint64_t own_occupancy = occupancy_[own_color_index];
    uint64_t opponent_occupancy = occupancy_[own_color_index ^ 1];
    uint64_t all_occupancy = own_occupancy | opponent_occupancy;

    int forward_direction = (us_color == Color::WHITE ? 8 : -8);
    int starting_rank_index = (us_color == Color::WHITE ? 1 : 6);
    int promotion_rank_index = (us_color == Color::WHITE ? 7 : 0);

    uint64_t scan_pawns = own_bitboards[PAWN];
    while (scan_pawns) {
        int pawn_square_index = std::countr_zero(scan_pawns);
        scan_pawns &= scan_pawns - 1;

        int one_step_square_index = pawn_square_index + forward_direction;
        if (!(all_occupancy & (1ULL << one_step_square_index))) {
            if (one_step_square_index / 8 == promotion_rank_index) {
                for (char promotion_piece : {'Q', 'R', 'B', 'N'})
                    out.push_back(Move(pawn_square_index, one_step_square_index, MoveType::PROMOTION, promotion_piece));
            }
            else {
                out.push_back(Move(pawn_square_index, one_step_square_index));

                if (pawn_square_index / 8 == starting_rank_index) {
                    int two_step_square_index = pawn_square_index + 2 * forward_direction;
                    if (!(all_occupancy & (1ULL << two_step_square_index)))
                        out.push_back(Move(pawn_square_index, two_step_square_index));
                }
            }
        }

        uint64_t attack_mask = ATTACK_TABLES.pawn_attacks[own_color_index][pawn_square_index];
        uint64_t pawn_captures = attack_mask & opponent_occupancy;
        while (pawn_captures) {
            int capture_square_index = std::countr_zero(pawn_captures);
            pawn_captures &= pawn_captures - 1;

            if (capture_square_index / 8 == promotion_rank_index) {
                for (char promotion_piece : {'Q', 'R', 'B', 'N'})
                    out.push_back(Move(pawn_square_index, capture_square_index, MoveType::PROMOTION, promotion_piece));
            }
            else {
                out.push_back(Move(pawn_square_index, capture_square_index, MoveType::CAPTURE));
            }
        }

        if (en_passant_square_index != -1 &&
            (attack_mask & (1ULL << en_passant_square_index)) &&
            !(all_occupancy & (1ULL << en_passant_square_index))) {
            out.push_back(Move(pawn_square_index, en_passant_square_index, MoveType::EN_PASSANT));
        }
    }

    auto emitMovesFromTargets = [&](int from_square_index, uint64_t targets) {
        uint64_t quiets = targets & ~all_occupancy;
        while (quiets) {
            int target_square_index = std::countr_zero(quiets);
            quiets &= quiets - 1;
            out.push_back(Move(from_square_index, target_square_index, MoveType::NORMAL));
        }
        uint64_t captures = targets & opponent_occupancy;
        while (captures) {
            int target_square_index = std::countr_zero(captures);
            captures &= captures - 1;
            out.push_back(Move(from_square_index, target_square_index, MoveType::CAPTURE));
        }
    };

    uint64_t scan_knights = own_bitboards[KNIGHT];
    while (scan_knights) {
        int knight_square_index = std::countr_zero(scan_knights);
        scan_knights &= scan_knights - 1;
        emitMovesFromTargets(knight_square_index, ATTACK_TABLES.knight_attacks[knight_square_index] & ~own_occupancy);
    }

    uint64_t scan_rooks = own_bitboards[ROOK];
    while (scan_rooks) {
        int from_square_index = std::countr_zero(scan_rooks);
        scan_rooks &= scan_rooks - 1;
        emitMovesFromTargets(from_square_index, rookAttacks(from_square_index, all_occupancy) & ~own_occupancy);
    }

    uint64_t scan_bishops = own_bitboards[BISHOP];
    while (scan_bishops) {
        int from_square_index = std::countr_zero(scan_bishops);
        scan_bishops &= scan_bishops - 1;
        emitMovesFromTargets(from_square_index, bishopAttacks(from_square_index, all_occupancy) & ~own_occupancy);
    }

    uint64_t scan_queens = own_bitboards[QUEEN];
    while (scan_queens) {
        int from_square_index = std::countr_zero(scan_queens);
        scan_queens &= scan_queens - 1;
        emitMovesFromTargets(from_square_index,
                     (rookAttacks(from_square_index, all_occupancy) |
                         bishopAttacks(from_square_index, all_occupancy)) & ~own_occupancy);
    }

    uint64_t scan_kings = own_bitboards[KING];
    while (scan_kings) {
        int king_square_index = std::countr_zero(scan_kings);
        scan_kings &= scan_kings - 1;
        emitMovesFromTargets(king_square_index, ATTACK_TABLES.king_attacks[king_square_index] & ~own_occupancy);
    }

    if (us_color == Color::WHITE) {
        if ((castling_rights & 0b0001) && !(all_occupancy & ((1ULL << 5) | (1ULL << 6))))
            out.push_back(Move(4, 6, MoveType::CASTLE_KINGSIDE));
        if ((castling_rights & 0b0010) && !(all_occupancy & ((1ULL << 1) | (1ULL << 2) | (1ULL << 3))))
            out.push_back(Move(4, 2, MoveType::CASTLE_QUEENSIDE));
    } else {
        if ((castling_rights & 0b0100) && !(all_occupancy & ((1ULL << 61) | (1ULL << 62))))
            out.push_back(Move(60, 62, MoveType::CASTLE_KINGSIDE));
        if ((castling_rights & 0b1000) && !(all_occupancy & ((1ULL << 57) | (1ULL << 58) | (1ULL << 59))))
            out.push_back(Move(60, 58, MoveType::CASTLE_QUEENSIDE));
    }
}

int Board::findKing(Color color) const {
    uint64_t king_bitboard = (color == Color::WHITE ? white_bitboards[KING] : black_bitboards[KING]);
    assert(king_bitboard != 0);
    return std::countr_zero(king_bitboard);
}

bool Board::isSquareAttacked(int squareIndex, Color attackingColor) const {
    const int attacker_color_index = (attackingColor == Color::WHITE ? 0 : 1);
    const auto& attacker_bitboards = (attackingColor == Color::WHITE ? white_bitboards : black_bitboards);

    // A pawn of the attacking color attacks squareIndex exactly when it sits
    // on a square that a defender-colored pawn on squareIndex would attack.
    if (ATTACK_TABLES.pawn_attacks[attacker_color_index ^ 1][squareIndex] & attacker_bitboards[PAWN]) return true;
    if (ATTACK_TABLES.knight_attacks[squareIndex] & attacker_bitboards[KNIGHT]) return true;
    if (ATTACK_TABLES.king_attacks[squareIndex] & attacker_bitboards[KING]) return true;

    uint64_t all_occupancy = occupancy_[0] | occupancy_[1];

    uint64_t bishop_like_bitboard = attacker_bitboards[BISHOP] | attacker_bitboards[QUEEN];
    if (bishop_like_bitboard && (bishopAttacks(squareIndex, all_occupancy) & bishop_like_bitboard)) return true;

    uint64_t rook_like_bitboard = attacker_bitboards[ROOK] | attacker_bitboards[QUEEN];
    if (rook_like_bitboard && (rookAttacks(squareIndex, all_occupancy) & rook_like_bitboard)) return true;

    return false;
}

void Board::generateLegalMoves(MoveList& out) const {
    MoveList pseudo_moves;
    generatePseudoMoves(pseudo_moves);

    if (!pieceBB(side_to_move, KING)) {
        out = pseudo_moves;
        return;
    }

    out.clear();

    Color opponent_color = (side_to_move == Color::WHITE ? Color::BLACK : Color::WHITE);
    uint64_t opponent_king_bitboard = pieceBB(opponent_color, KING);

    // Legality is checked by make/unmake on this board rather than by
    // copying it (a full copy dragged the move_history vector with it).
    // makeMove+unmakeMove restore every field, so const-ness holds
    // observably even though we mutate through the cast.
    Board* mutable_board = const_cast<Board*>(this);

    for (const auto& move : pseudo_moves) {
        if (opponent_king_bitboard & (1ULL << move.end))
            continue;

        if (move.type == MoveType::CASTLE_KINGSIDE || move.type == MoveType::CASTLE_QUEENSIDE) {
            int king_start_square = move.start;
            int king_step = (move.type == MoveType::CASTLE_KINGSIDE ? +1 : -1);
            int king_middle_square = king_start_square + king_step;

            if (isSquareAttacked(king_start_square, opponent_color)) continue;
            if (isSquareAttacked(king_middle_square, opponent_color)) continue;
        }

        if (mutable_board->makeMove(move)) {
            mutable_board->unmakeMove();
            out.push_back(move);
        }
    }
}

bool Board::makeMove(const Move& move) {
    Undo undo_entry;
    undo_entry.castling_rights = castling_rights;
    undo_entry.en_passant_square_index = en_passant_square_index;
    undo_entry.halfmove_clock = halfmove_clock;
    undo_entry.fullmove_number = fullmove_number;
    undo_entry.move = move;

    undo_entry.zobrist_key = current_zobrist_key;

    undo_entry.is_pawn_double_push = false;
    undo_entry.is_castling_move = false;
    undo_entry.castling_rook_from_square = -1;
    undo_entry.castling_rook_to_square = -1;

    uint64_t from_mask = 1ULL << move.start;
    uint64_t to_mask = 1ULL << move.end;

    Color us_color = side_to_move;
    Color opponent_color = (us_color == Color::WHITE ? Color::BLACK : Color::WHITE);

    const int own_color_index = (us_color == Color::WHITE ? 0 : 1);
    auto& own_bitboards = (us_color == Color::WHITE ? white_bitboards : black_bitboards);
    auto& opponent_bitboards = (us_color == Color::WHITE ? black_bitboards : white_bitboards);

    if (!(occupancy_[own_color_index] & from_mask)) {
        return false;
    }
    PieceIndex moved_piece_index = static_cast<PieceIndex>(mailbox_[move.start]);

    undo_entry.moved_piece = moved_piece_index;

    PieceIndex captured_piece_index = PieceTypeCount;

    if (occupancy_[own_color_index ^ 1] & to_mask) {
        captured_piece_index = static_cast<PieceIndex>(mailbox_[move.end]);
        clearBit(opponent_bitboards[captured_piece_index], move.end);
        occupancy_[own_color_index ^ 1] &= ~to_mask;
    }

    if (move.type == MoveType::EN_PASSANT) {
        int captured_pawn_square =
            (us_color == Color::WHITE ? move.end - 8 : move.end + 8);
        clearBit(opponent_bitboards[PAWN], captured_pawn_square);
        occupancy_[own_color_index ^ 1] &= ~(1ULL << captured_pawn_square);
        mailbox_[captured_pawn_square] = PieceTypeCount;
        captured_piece_index = PAWN;
    }
    undo_entry.captured_piece = captured_piece_index;

    if (move.type == MoveType::CASTLE_KINGSIDE || move.type == MoveType::CASTLE_QUEENSIDE) {
        undo_entry.is_castling_move = true;
        int rook_from_square = (move.type == MoveType::CASTLE_KINGSIDE ? move.start + 3 : move.start - 4);
        int rook_to_square = (move.type == MoveType::CASTLE_KINGSIDE ? move.start + 1 : move.start - 1);
        undo_entry.castling_rook_from_square = rook_from_square;
        undo_entry.castling_rook_to_square = rook_to_square;

        clearBit(own_bitboards[ROOK], rook_from_square);
        setBit(own_bitboards[ROOK], rook_to_square);
        occupancy_[own_color_index] &= ~(1ULL << rook_from_square);
        occupancy_[own_color_index] |= (1ULL << rook_to_square);
        mailbox_[rook_from_square] = PieceTypeCount;
        mailbox_[rook_to_square] = ROOK;
    }

    {
        clearBit(own_bitboards[moved_piece_index], move.start);

        PieceIndex landing_piece_index = moved_piece_index;
        if (move.type == MoveType::PROMOTION && move.promo) {
            landing_piece_index = QUEEN;
            switch (move.promo) {
            case 'R': landing_piece_index = ROOK;
                break;
            case 'B': landing_piece_index = BISHOP;
                break;
            case 'N': landing_piece_index = KNIGHT;
                break;
            }
        }
        setBit(own_bitboards[landing_piece_index], move.end);

        occupancy_[own_color_index] = (occupancy_[own_color_index] & ~from_mask) | to_mask;
        mailbox_[move.start] = PieceTypeCount;
        mailbox_[move.end] = landing_piece_index;
    }

    if (moved_piece_index == KING) {
        if (us_color == Color::WHITE) castling_rights &= 0b1100;
        else castling_rights &= 0b0011;
    } else if (moved_piece_index == ROOK) {
        if (move.start == 0) castling_rights &= 0b1101;
        if (move.start == 7) castling_rights &= 0b1110;
        if (move.start == 56) castling_rights &= 0b0111;
        if (move.start == 63) castling_rights &= 0b1011;
    }

    if (captured_piece_index == ROOK) {
        if (move.end == 0) castling_rights &= 0b1101;
        if (move.end == 7) castling_rights &= 0b1110;
        if (move.end == 56) castling_rights &= 0b0111;
        if (move.end == 63) castling_rights &= 0b1011;
    }

    en_passant_square_index = -1;
    if (moved_piece_index == PAWN &&
        std::abs((move.end / 8) - (move.start / 8)) == 2) {
        en_passant_square_index = (move.start + move.end) / 2;
        undo_entry.is_pawn_double_push = true;
    }

    if (moved_piece_index == PAWN || captured_piece_index != PieceTypeCount) {
        halfmove_clock = 0;
    }
    else {
        ++halfmove_clock;
    }

    if (us_color == Color::BLACK)
        ++fullmove_number;

    side_to_move = opponent_color;

    current_zobrist_key ^= castling_keys[undo_entry.castling_rights];
    if (undo_entry.en_passant_square_index != -1) {
        current_zobrist_key ^= en_passant_keys[undo_entry.en_passant_square_index];
    }

    current_zobrist_key ^= castling_keys[castling_rights];
    if (en_passant_square_index != -1) {
        current_zobrist_key ^= en_passant_keys[en_passant_square_index];
    }

    current_zobrist_key ^= side_key;

    int moved_side_offset = (us_color == Color::WHITE ? 0 : 6);

    current_zobrist_key ^= piece_keys[undo_entry.moved_piece + moved_side_offset][move.start];

    if (move.type == MoveType::PROMOTION) {
        PieceIndex promoPiece = QUEEN;
        if (move.promo == 'R') promoPiece = ROOK;
        else if (move.promo == 'B') promoPiece = BISHOP;
        else if (move.promo == 'N') promoPiece = KNIGHT;
        current_zobrist_key ^= piece_keys[promoPiece + moved_side_offset][move.end];
    }
    else {
        current_zobrist_key ^= piece_keys[undo_entry.moved_piece + moved_side_offset][move.end];
    }

    if (undo_entry.captured_piece != PieceTypeCount) {
        int captured_side_offset = (opponent_color == Color::WHITE ? 0 : 6);
        int capture_square = move.end;

        if (move.type == MoveType::EN_PASSANT) {
            capture_square = (us_color == Color::WHITE ? move.end - 8 : move.end + 8);
        }

        current_zobrist_key ^= piece_keys[undo_entry.captured_piece + captured_side_offset][capture_square];
    }

    if (undo_entry.is_castling_move) {
        int rook_side_offset = (us_color == Color::WHITE ? 0 : 6);
        current_zobrist_key ^= piece_keys[ROOK + rook_side_offset][undo_entry.castling_rook_from_square];
        current_zobrist_key ^= piece_keys[ROOK + rook_side_offset][undo_entry.castling_rook_to_square];
    }

    move_history.push_back(undo_entry);

    if (pieceBB(us_color, KING) &&
        isSquareAttacked(findKing(us_color), opponent_color)) {
        unmakeMove();
        return false;
    }

    return true;
}

void Board::unmakeMove() {
    assert(!move_history.empty());
    Undo undo_entry = move_history.back();
    move_history.pop_back();

    current_zobrist_key = undo_entry.zobrist_key;

    Move move = undo_entry.move;

    Color opponent_color = side_to_move;
    Color us_color = (opponent_color == Color::WHITE ? Color::BLACK : Color::WHITE);

    side_to_move = us_color;
    castling_rights = undo_entry.castling_rights;
    en_passant_square_index = undo_entry.en_passant_square_index;
    halfmove_clock = undo_entry.halfmove_clock;
    fullmove_number = undo_entry.fullmove_number;

    const int own_color_index = (us_color == Color::WHITE ? 0 : 1);
    auto& own_bitboards = (us_color == Color::WHITE ? white_bitboards : black_bitboards);
    auto& opponent_bitboards = (opponent_color == Color::WHITE ? white_bitboards : black_bitboards);

    const uint64_t from_mask = 1ULL << move.start;
    const uint64_t to_mask = 1ULL << move.end;

    {
        // Original promotion path applied the pawn->piece swap whenever
        // move.promo was set; with promo unset the piece moved back as-is.
        PieceIndex landed_piece_index = undo_entry.moved_piece;
        if (move.type == MoveType::PROMOTION && move.promo) {
            landed_piece_index = QUEEN;
            switch (move.promo) {
            case 'R': landed_piece_index = ROOK;
                break;
            case 'B': landed_piece_index = BISHOP;
                break;
            case 'N': landed_piece_index = KNIGHT;
                break;
            }
        }
        clearBit(own_bitboards[landed_piece_index], move.end);
        setBit(own_bitboards[undo_entry.moved_piece], move.start);

        occupancy_[own_color_index] = (occupancy_[own_color_index] & ~to_mask) | from_mask;
        mailbox_[move.end] = PieceTypeCount;
        mailbox_[move.start] = undo_entry.moved_piece;
    }

    if (undo_entry.captured_piece < PieceTypeCount) {
        int restore_square_index =
            (move.type == MoveType::EN_PASSANT)
                ? (us_color == Color::WHITE ? move.end - 8 : move.end + 8)
                : move.end;
        setBit(opponent_bitboards[undo_entry.captured_piece], restore_square_index);
        occupancy_[own_color_index ^ 1] |= (1ULL << restore_square_index);
        mailbox_[restore_square_index] = undo_entry.captured_piece;
    }

    if (undo_entry.is_castling_move) {
        clearBit(own_bitboards[ROOK], undo_entry.castling_rook_to_square);
        setBit(own_bitboards[ROOK], undo_entry.castling_rook_from_square);
        occupancy_[own_color_index] &= ~(1ULL << undo_entry.castling_rook_to_square);
        occupancy_[own_color_index] |= (1ULL << undo_entry.castling_rook_from_square);
        mailbox_[undo_entry.castling_rook_to_square] = PieceTypeCount;
        mailbox_[undo_entry.castling_rook_from_square] = ROOK;
    }
}

bool Board::inCheck(Color color) const {
    int king_square_index = findKing(color);
    Color attacker_color = (color == Color::WHITE ? Color::BLACK : Color::WHITE);
    return isSquareAttacked(king_square_index, attacker_color);
}

bool Board::hasLegalMoves(Color color) const {
    Color saved_side_to_move = side_to_move;
    const_cast<Board*>(this)->side_to_move = color;
    MoveList legal_moves;
    generateLegalMoves(legal_moves);
    const_cast<Board*>(this)->side_to_move = saved_side_to_move;
    return !legal_moves.empty();
}

bool Board::isCheckmate(Color color) const {
    return inCheck(color) && !hasLegalMoves(color);
}

bool Board::isStalemate(Color color) const {
    return !inCheck(color) && !hasLegalMoves(color);
}

bool Board::isFiftyMoveDraw() const {
    // 100 halfmoves without a pawn move or capture. Checkmate on the 100th
    // halfmove technically overrides this; the search checks for legal moves
    // and mate before consulting draw rules, so that ordering is preserved.
    return halfmove_clock >= 100;
}

bool Board::isThreefoldRepetition() const {
    int repetitionCount = 1;
    int historySize = move_history.size();

    for (int i = historySize - 2; i >= 0; i -= 2) {
        if (move_history[i].zobrist_key == current_zobrist_key) {
            repetitionCount++;
            if (repetitionCount >= 3) return true;
        }

        if (move_history[i].moved_piece == PAWN ||
            move_history[i].captured_piece != PieceTypeCount) {
            break;
        }
    }

    return false;
}

bool Board::isRepetitionDraw() const {
    int historySize = move_history.size();

    for (int i = historySize - 2; i >= 0; i -= 2) {
        if (move_history[i].zobrist_key == current_zobrist_key) {
            return true;
        }

        if (move_history[i].moved_piece == PAWN ||
            move_history[i].captured_piece != PieceTypeCount) {
            break;
        }
    }

    return false;
}

bool Board::isInsufficientMaterial() const {
    // Any pawn, rook or queen on the board means mate is still possible.
    if (white_bitboards[PAWN] | black_bitboards[PAWN] |
        white_bitboards[ROOK] | black_bitboards[ROOK] |
        white_bitboards[QUEEN] | black_bitboards[QUEEN]) {
        return false;
    }

    uint64_t white_minors = white_bitboards[KNIGHT] | white_bitboards[BISHOP];
    uint64_t black_minors = black_bitboards[KNIGHT] | black_bitboards[BISHOP];
    int minor_count = std::popcount(white_minors) + std::popcount(black_minors);

    // K vs K, or a single minor piece vs bare king: dead draw.
    if (minor_count <= 1) return true;

    // KB vs KB with both bishops on the same square color: dead draw.
    if (minor_count == 2 &&
        std::popcount(white_bitboards[BISHOP]) == 1 &&
        std::popcount(black_bitboards[BISHOP]) == 1) {
        constexpr uint64_t light_squares = 0x55AA55AA55AA55AAULL;
        bool white_on_light = white_bitboards[BISHOP] & light_squares;
        bool black_on_light = black_bitboards[BISHOP] & light_squares;
        return white_on_light == black_on_light;
    }

    return false;
}

void Board::printBoard() const {
    std::cout << "================= BOARD DEBUG =================\n";

    printFENString();
    printPseudoLegalMoves();
    printLegalMoves();
    printBitboards();

    std::cout << "===============================================\n";
    std::cout << "printboard_done\n";
    std::cout << std::flush;
}

void Board::printFENString() const {
    std::cout << "FEN: " << toFEN() << '\n';
}

void Board::printPseudoLegalMoves() const {
    MoveList pseudo_legal_moves;
    generatePseudoMoves(pseudo_legal_moves);

    std::cout << "Pseudo-legal moves (" << pseudo_legal_moves.size() << "):";
    for (const Move& move : pseudo_legal_moves) {
        std::cout << ' ' << move.toString();
    }
    std::cout << '\n';
}

void Board::printLegalMoves() const {
    MoveList legal_moves;
    generateLegalMoves(legal_moves);

    std::cout << "Legal moves (" << legal_moves.size() << "):";
    for (const Move& move : legal_moves) {
        std::cout << ' ' << move.toString();
    }
    std::cout << '\n';
}

void Board::printSingleBitboard(uint64_t bitboard, const std::string& label) {
    std::cout << label << '\n';

    for (int rank_index = 7; rank_index >= 0; --rank_index) {
        std::cout << (rank_index + 1) << "  ";
        for (int file_index = 0; file_index < 8; ++file_index) {
            int square_index = rank_index * 8 + file_index;
            bool is_set = (bitboard & (1ULL << square_index)) != 0;
            std::cout << (is_set ? '1' : '.') << ' ';
        }
        std::cout << '\n';
    }

    std::cout << "   a b c d e f g h\n\n";
}

void Board::printBitboards() const {
    static const char* piece_names[PieceTypeCount] = {"Pawns", "Knights", "Bishops", "Rooks", "Queens", "Kings"};

    for (int piece_type_index = 0; piece_type_index < PieceTypeCount; ++piece_type_index) {
        std::string white_label = std::string("White ") + piece_names[piece_type_index];
        std::string black_label = std::string("Black ") + piece_names[piece_type_index];

        printSingleBitboard(white_bitboards[piece_type_index], white_label);
        printSingleBitboard(black_bitboards[piece_type_index], black_label);
    }
}

void Board::makeNullMove() {
    Undo undo;
    undo.castling_rights = castling_rights;
    undo.en_passant_square_index = en_passant_square_index;
    undo.halfmove_clock = halfmove_clock;
    undo.fullmove_number = fullmove_number;
    undo.zobrist_key = current_zobrist_key;
    undo.move = Move();
    undo.captured_piece = PieceTypeCount;
    undo.moved_piece = PieceTypeCount;
    undo.is_pawn_double_push = false;
    undo.is_castling_move = false;
    undo.castling_rook_from_square = -1;
    undo.castling_rook_to_square = -1;

    move_history.push_back(undo);

    current_zobrist_key ^= side_key;
    if (en_passant_square_index != -1) {
        current_zobrist_key ^= en_passant_keys[en_passant_square_index];
        en_passant_square_index = -1;
    }

    side_to_move = (side_to_move == Color::WHITE) ? Color::BLACK : Color::WHITE;
}

void Board::unmakeNullMove() {
    const Undo& undo = move_history.back();
    current_zobrist_key = undo.zobrist_key;
    castling_rights = undo.castling_rights;
    en_passant_square_index = undo.en_passant_square_index;
    halfmove_clock = undo.halfmove_clock;
    side_to_move = (side_to_move == Color::WHITE) ? Color::BLACK : Color::WHITE;
    move_history.pop_back();
}
