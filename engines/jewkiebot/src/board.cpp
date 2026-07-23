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

uint64_t Board::knight_attacks[64];
uint64_t Board::king_attacks[64];
uint64_t Board::pawn_attacks[2][64];

// Zobrist keys and leaper attack tables. Called from every constructor so a
// Board built directly from a FEN string is initialized too.
static void initBoardTablesImpl(uint64_t piece_keys[12][64],
                                uint64_t en_passant_keys[64],
                                uint64_t castling_keys[16],
                                uint64_t& side_key,
                                uint64_t knight_attacks[64],
                                uint64_t king_attacks[64],
                                uint64_t pawn_attacks[2][64]) {
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

    static const int knight_deltas[8][2] = {{-2,-1},{-2,1},{-1,-2},{-1,2},{1,-2},{1,2},{2,-1},{2,1}};
    static const int king_deltas[8][2] = {{-1,-1},{-1,0},{-1,1},{0,-1},{0,1},{1,-1},{1,0},{1,1}};

    for (int sq = 0; sq < 64; ++sq) {
        int rank = sq / 8;
        int file = sq % 8;

        uint64_t knight_bb = 0;
        for (auto& d : knight_deltas) {
            int r = rank + d[0], f = file + d[1];
            if (r >= 0 && r < 8 && f >= 0 && f < 8) knight_bb |= 1ULL << (r * 8 + f);
        }
        knight_attacks[sq] = knight_bb;

        uint64_t king_bb = 0;
        for (auto& d : king_deltas) {
            int r = rank + d[0], f = file + d[1];
            if (r >= 0 && r < 8 && f >= 0 && f < 8) king_bb |= 1ULL << (r * 8 + f);
        }
        king_attacks[sq] = king_bb;

        uint64_t white_pawn_bb = 0;
        uint64_t black_pawn_bb = 0;
        for (int df : {-1, 1}) {
            int f = file + df;
            if (f < 0 || f > 7) continue;
            if (rank + 1 < 8) white_pawn_bb |= 1ULL << ((rank + 1) * 8 + f);
            if (rank - 1 >= 0) black_pawn_bb |= 1ULL << ((rank - 1) * 8 + f);
        }
        pawn_attacks[static_cast<int>(Color::WHITE)][sq] = white_pawn_bb;
        pawn_attacks[static_cast<int>(Color::BLACK)][sq] = black_pawn_bb;
    }
}

void Board::initStaticTables() {
    std::call_once(zobrist_once_flag_, []() {
        initBoardTablesImpl(piece_keys, en_passant_keys, castling_keys, side_key,
                            knight_attacks, king_attacks, pawn_attacks);
    });
}

Board::Board() {
    initStaticTables();

    // init board itself
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
    move_history.reserve(512);

    current_zobrist_key = calculateZobristKey(*this);
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

    fen_stream >> placement_field >> side_to_move_field >> castling_rights_field >> en_passant_field >> halfmove_clock >> fullmove_number;

    int rank_index = 7;
    int file_index = 0;

    for (char piece_character : placement_field) {
        if (piece_character == '/') {
            --rank_index;
            file_index = 0;
            continue;
        }

        if (std::isdigit(static_cast<unsigned char>(piece_character))) {
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
    if (castling_rights_field.find('K') != std::string::npos) castling_rights |= 0b0001;
    if (castling_rights_field.find('Q') != std::string::npos) castling_rights |= 0b0010;
    if (castling_rights_field.find('k') != std::string::npos) castling_rights |= 0b0100;
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
    move_history.reserve(512);

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

uint64_t Board::occupancy(Color color) const {
    uint64_t occupancy_bitboard = 0;
    const auto& bitboards = (color == Color::WHITE ? white_bitboards : black_bitboards);
    for (uint64_t piece_bitboard : bitboards)
        occupancy_bitboard |= piece_bitboard;
    return occupancy_bitboard;
}

uint64_t Board::pieceBB(Color color, PieceIndex pieceIndex) const {
    return (color == Color::WHITE ? white_bitboards[pieceIndex] : black_bitboards[pieceIndex]);
}

void Board::generatePseudoMoves(MoveList& move_list) const {
    move_list.clear();

    Color us_color = side_to_move;

    uint64_t white_occupancy = occupancy(Color::WHITE);
    uint64_t black_occupancy = occupancy(Color::BLACK);
    uint64_t all_occupancy = white_occupancy | black_occupancy;
    uint64_t own_occupancy = (us_color == Color::WHITE ? white_occupancy : black_occupancy);
    uint64_t opponent_occupancy = (us_color == Color::WHITE ? black_occupancy : white_occupancy);

    uint64_t pawn_bitboard = (us_color == Color::WHITE ? white_bitboards[PAWN] : black_bitboards[PAWN]);
    int forward_direction = (us_color == Color::WHITE ? 8 : -8);
    int starting_rank_index = (us_color == Color::WHITE ? 1 : 6);
    int promotion_rank_index = (us_color == Color::WHITE ? 7 : 0);

    uint64_t scan_pawns = pawn_bitboard;
    while (scan_pawns) {
        int pawn_square_index = std::countr_zero(scan_pawns);
        scan_pawns &= scan_pawns - 1;

        int one_step_square_index = pawn_square_index + forward_direction;
        if (inBounds(one_step_square_index) && !(all_occupancy & (1ULL << one_step_square_index))) {
            if (one_step_square_index / 8 == promotion_rank_index) {
                for (char promotion_piece : {'Q', 'R', 'B', 'N'})
                    move_list.push_back(Move(pawn_square_index, one_step_square_index, MoveType::PROMOTION, promotion_piece));
            }
            else {
                move_list.push_back(Move(pawn_square_index, one_step_square_index));

                if (pawn_square_index / 8 == starting_rank_index) {
                    int two_step_square_index = pawn_square_index + 2 * forward_direction;
                    if (inBounds(two_step_square_index) && !(all_occupancy & (1ULL << two_step_square_index)))
                        move_list.push_back(Move(pawn_square_index, two_step_square_index));
                }
            }
        }

        uint64_t capture_targets = pawn_attacks[static_cast<int>(us_color)][pawn_square_index];
        uint64_t scan_captures = capture_targets & opponent_occupancy;
        while (scan_captures) {
            int capture_square_index = std::countr_zero(scan_captures);
            scan_captures &= scan_captures - 1;

            if (capture_square_index / 8 == promotion_rank_index) {
                for (char promotion_piece : {'Q', 'R', 'B', 'N'})
                    move_list.push_back(Move(pawn_square_index, capture_square_index, MoveType::PROMOTION, promotion_piece));
            }
            else {
                move_list.push_back(Move(pawn_square_index, capture_square_index, MoveType::CAPTURE));
            }
        }

        if (en_passant_square_index != -1 &&
            (capture_targets & (1ULL << en_passant_square_index))) {
            move_list.push_back(Move(pawn_square_index, en_passant_square_index, MoveType::EN_PASSANT));
        }
    }

    uint64_t knight_bitboard = (us_color == Color::WHITE ? white_bitboards[KNIGHT] : black_bitboards[KNIGHT]);
    uint64_t scan_knights = knight_bitboard;
    while (scan_knights) {
        int knight_square_index = std::countr_zero(scan_knights);
        scan_knights &= scan_knights - 1;

        uint64_t targets = knight_attacks[knight_square_index] & ~own_occupancy;
        while (targets) {
            int target_square_index = std::countr_zero(targets);
            targets &= targets - 1;

            MoveType move_type = (opponent_occupancy & (1ULL << target_square_index))
                                     ? MoveType::CAPTURE
                                     : MoveType::NORMAL;
            move_list.push_back(Move(knight_square_index, target_square_index, move_type));
        }
    }

    auto slidePieces = [&](uint64_t piece_bitboard, const int file_directions[], const int rank_directions[], int direction_count) {
        uint64_t scan_sliders = piece_bitboard;
        while (scan_sliders) {
            int from_square_index = std::countr_zero(scan_sliders);
            scan_sliders &= scan_sliders - 1;

            int start_file = from_square_index % 8;
            int start_rank = from_square_index / 8;

            for (int direction_index = 0; direction_index < direction_count; ++direction_index) {
                int file_step = file_directions[direction_index];
                int rank_step = rank_directions[direction_index];

                int file = start_file;
                int rank = start_rank;

                while (true) {
                    file += file_step;
                    rank += rank_step;

                    if (file < 0 || file > 7 || rank < 0 || rank > 7)
                        break;

                    int target_square_index = rank * 8 + file;

                    if (own_occupancy & (1ULL << target_square_index))
                        break;

                    if (opponent_occupancy & (1ULL << target_square_index)) {
                        move_list.push_back(Move(from_square_index, target_square_index, MoveType::CAPTURE));
                        break;
                    }

                    move_list.push_back(Move(from_square_index, target_square_index, MoveType::NORMAL));
                }
            }
        }
    };

    static const int rook_file_directions[4] = {-1, 1, 0, 0};
    static const int rook_rank_directions[4] = {0, 0, -1, 1};

    slidePieces((us_color == Color::WHITE ? white_bitboards[ROOK] : black_bitboards[ROOK]), rook_file_directions, rook_rank_directions, 4);

    static const int bishop_file_directions[4] = {-1, 1, -1, 1};
    static const int bishop_rank_directions[4] = {-1, -1, 1, 1};

    slidePieces((us_color == Color::WHITE ? white_bitboards[BISHOP] : black_bitboards[BISHOP]), bishop_file_directions, bishop_rank_directions, 4);
    slidePieces((us_color == Color::WHITE ? white_bitboards[QUEEN] : black_bitboards[QUEEN]), rook_file_directions, rook_rank_directions, 4);
    slidePieces((us_color == Color::WHITE ? white_bitboards[QUEEN] : black_bitboards[QUEEN]), bishop_file_directions, bishop_rank_directions, 4);

    uint64_t king_bitboard = (us_color == Color::WHITE ? white_bitboards[KING] : black_bitboards[KING]);
    uint64_t scan_kings = king_bitboard;
    while (scan_kings) {
        int king_square_index = std::countr_zero(scan_kings);
        scan_kings &= scan_kings - 1;

        uint64_t targets = king_attacks[king_square_index] & ~own_occupancy;
        while (targets) {
            int target_square_index = std::countr_zero(targets);
            targets &= targets - 1;

            MoveType move_type = (opponent_occupancy & (1ULL << target_square_index))
                                     ? MoveType::CAPTURE
                                     : MoveType::NORMAL;
            move_list.push_back(Move(king_square_index, target_square_index, move_type));
        }
    }

    if (us_color == Color::WHITE) {
        if ((castling_rights & 0b0001) && !(all_occupancy & ((1ULL << 5) | (1ULL << 6))))
            move_list.push_back(Move(4, 6, MoveType::CASTLE_KINGSIDE));
        if ((castling_rights & 0b0010) && !(all_occupancy & ((1ULL << 1) | (1ULL << 2) | (1ULL << 3))))
            move_list.push_back(Move(4, 2, MoveType::CASTLE_QUEENSIDE));
    }
    else {
        if ((castling_rights & 0b0100) && !(all_occupancy & ((1ULL << 61) | (1ULL << 62))))
            move_list.push_back(Move(60, 62, MoveType::CASTLE_KINGSIDE));
        if ((castling_rights & 0b1000) && !(all_occupancy & ((1ULL << 57) | (1ULL << 58) | (1ULL << 59))))
            move_list.push_back(Move(60, 58, MoveType::CASTLE_QUEENSIDE));
    }

#ifndef NDEBUG
    for (const auto& move : move_list) {
        auto uci_string = move.toString();
        auto parsed_move = Move::fromUCI(uci_string);
        assert(parsed_move.start == move.start &&
            parsed_move.end == move.end &&
            parsed_move.promo == move.promo);
    }
#endif
}

std::vector<Move> Board::generatePseudoMoves() const {
    MoveList list;
    generatePseudoMoves(list);
    return std::vector<Move>(list.begin(), list.end());
}

int Board::findKing(Color color) const {
    uint64_t king_bitboard = (color == Color::WHITE ? white_bitboards[KING] : black_bitboards[KING]);
    assert(king_bitboard != 0);
    return std::countr_zero(king_bitboard);
}

bool Board::isSquareAttacked(int squareIndex, Color attackingColor) const {
    uint64_t white_occupancy = occupancy(Color::WHITE);
    uint64_t black_occupancy = occupancy(Color::BLACK);
    uint64_t all_occupancy = white_occupancy | black_occupancy;

    // A pawn of `attackingColor` attacks squareIndex exactly when a pawn of
    // the *defending* color on squareIndex would attack the pawn's square.
    Color defending_color = (attackingColor == Color::WHITE ? Color::BLACK : Color::WHITE);
    uint64_t attacking_pawns = (attackingColor == Color::WHITE ? white_bitboards[PAWN] : black_bitboards[PAWN]);
    if (pawn_attacks[static_cast<int>(defending_color)][squareIndex] & attacking_pawns) return true;

    uint64_t knight_bitboard = (attackingColor == Color::WHITE ? white_bitboards[KNIGHT] : black_bitboards[KNIGHT]);
    if (knight_attacks[squareIndex] & knight_bitboard) return true;

    static const int bishop_directions[4] = {-9, -7, 7, 9};
    uint64_t bishop_like_bitboard =
    (attackingColor == Color::WHITE
         ? white_bitboards[BISHOP] | white_bitboards[QUEEN]
         : black_bitboards[BISHOP] | black_bitboards[QUEEN]);

    for (int direction : bishop_directions) {
        int current_square_index = squareIndex;
        while (true) {
            int from_file = current_square_index % 8;
            current_square_index += direction;
            if (!inBounds(current_square_index)) break;
            int to_file = current_square_index % 8;
            if (std::abs(to_file - from_file) != 1) break;

            uint64_t mask = 1ULL << current_square_index;
            if (all_occupancy & mask) {
                if (bishop_like_bitboard & mask) return true;
                break;
            }
        }
    }

    static const int rook_directions[4] = {-8, -1, 1, 8};
    uint64_t rook_like_bitboard =
    (attackingColor == Color::WHITE
         ? white_bitboards[ROOK] | white_bitboards[QUEEN]
         : black_bitboards[ROOK] | black_bitboards[QUEEN]);

    for (int direction : rook_directions) {
        int current_square_index = squareIndex;
        while (true) {
            int from_rank = current_square_index / 8;
            int from_file = current_square_index % 8;

            current_square_index += direction;
            if (!inBounds(current_square_index)) break;

            int to_rank = current_square_index / 8;
            int to_file = current_square_index % 8;

            if (direction == -1 || direction == 1) {
                if (to_rank != from_rank) break;
            }

            uint64_t mask = 1ULL << current_square_index;
            if (all_occupancy & mask) {
                if (rook_like_bitboard & mask) return true;
                break;
            }
        }
    }

    uint64_t king_bitboard = (attackingColor == Color::WHITE ? white_bitboards[KING] : black_bitboards[KING]);
    if (king_attacks[squareIndex] & king_bitboard) return true;

    return false;
}

void Board::generateLegalMoves(MoveList& legal_moves) const {
    MoveList pseudo_moves;
    generatePseudoMoves(pseudo_moves);

    if (!pieceBB(side_to_move, KING)) {
        legal_moves = pseudo_moves;
        return;
    }

    legal_moves.clear();

    Color opponent_color = (side_to_move == Color::WHITE ? Color::BLACK : Color::WHITE);
    uint64_t opponent_king_bitboard = pieceBB(opponent_color, KING);

    // makeMove/unmakeMove restore the position exactly, so legality testing
    // can run on this board directly instead of deep-copying it per move.
    Board& self = const_cast<Board&>(*this);

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

        if (self.makeMove(move)) {
            self.unmakeMove();
            legal_moves.push_back(move);
        }
    }
}

std::vector<Move> Board::generateLegalMoves() const {
    MoveList list;
    generateLegalMoves(list);
    return std::vector<Move>(list.begin(), list.end());
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

    PieceIndex moved_piece_index = PAWN;
    bool found_moved = false;
    for (int piece_type_index = 0; piece_type_index < PieceTypeCount; ++piece_type_index) {
        uint64_t piece_bitboard =
        (us_color == Color::WHITE
             ? white_bitboards[piece_type_index]
             : black_bitboards[piece_type_index]);

        if (testBit(piece_bitboard, move.start)) {
            moved_piece_index = static_cast<PieceIndex>(piece_type_index);
            found_moved = true;
            break;
        }
    }

    if (!found_moved) {
        return false;
    }

    undo_entry.moved_piece = moved_piece_index;

    PieceIndex captured_piece_index = PieceTypeCount;
    for (int piece_type_index = 0; piece_type_index < PieceTypeCount; ++piece_type_index) {
        auto& opponent_bitboard =
        (opponent_color == Color::WHITE
             ? white_bitboards[piece_type_index]
             : black_bitboards[piece_type_index]);
        if (testBit(opponent_bitboard, move.end)) {
            clearBit(opponent_bitboard, move.end);
            captured_piece_index = static_cast<PieceIndex>(piece_type_index);
            break;
        }
    }

    if (move.type == MoveType::EN_PASSANT) {
        int captured_pawn_square =
            (us_color == Color::WHITE ? move.end - 8 : move.end + 8);
        auto& pawn_bitboard =
        (opponent_color == Color::WHITE
             ? white_bitboards[PAWN]
             : black_bitboards[PAWN]);
        clearBit(pawn_bitboard, captured_pawn_square);
        captured_piece_index = PAWN;
    }
    undo_entry.captured_piece = captured_piece_index;

    if (move.type == MoveType::CASTLE_KINGSIDE || move.type == MoveType::CASTLE_QUEENSIDE) {
        undo_entry.is_castling_move = true;
        int rook_from_square = (move.type == MoveType::CASTLE_KINGSIDE ? move.start + 3 : move.start - 4);
        int rook_to_square = (move.type == MoveType::CASTLE_KINGSIDE ? move.start + 1 : move.start - 1);
        undo_entry.castling_rook_from_square = rook_from_square;
        undo_entry.castling_rook_to_square = rook_to_square;

        auto& rook_bitboard = (us_color == Color::WHITE ? white_bitboards[ROOK] : black_bitboards[ROOK]);
        clearBit(rook_bitboard, rook_from_square);
        setBit(rook_bitboard, rook_to_square);
    }

    {
        auto& moved_piece_bitboard =
        (us_color == Color::WHITE
             ? white_bitboards[moved_piece_index]
             : black_bitboards[moved_piece_index]);

        clearBit(moved_piece_bitboard, move.start);

        if (move.type == MoveType::PROMOTION && move.promo) {
            PieceIndex promotion_piece_index = QUEEN;
            switch (move.promo) {
            case 'R': promotion_piece_index = ROOK;
                break;
            case 'B': promotion_piece_index = BISHOP;
                break;
            case 'N': promotion_piece_index = KNIGHT;
                break;
            }
            auto& promotion_bitboard =
            (us_color == Color::WHITE
                 ? white_bitboards[promotion_piece_index]
                 : black_bitboards[promotion_piece_index]);
            setBit(promotion_bitboard, move.end);

            //     << (int)promotion_piece_index
            //     << " at " << move.end << "\n";
        }
        else {
            setBit(moved_piece_bitboard, move.end);
        }
    }

    if (moved_piece_index == KING) {
        if (us_color == Color::WHITE) castling_rights &= 0b1100;
        else castling_rights &= 0b0011;
    }
    else if (moved_piece_index == ROOK) {
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
        //     << en_passant_square_index << "\n";
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
    } else {
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

    if (move.type == MoveType::PROMOTION) {
        PieceIndex promoted_piece_index = QUEEN;
        switch (move.promo) {
        case 'R': promoted_piece_index = ROOK;
            break;
        case 'B': promoted_piece_index = BISHOP;
            break;
        case 'N': promoted_piece_index = KNIGHT;
            break;
        }
        auto& promoted_piece_bitboard = (
            us_color == Color::WHITE
                ? white_bitboards[promoted_piece_index]
                : black_bitboards[promoted_piece_index]);
        clearBit(promoted_piece_bitboard, move.end);

        auto& pawn_bitboard =
        (us_color == Color::WHITE
             ? white_bitboards[PAWN]
             : black_bitboards[PAWN]);
        setBit(pawn_bitboard, move.start);
    }
    else {
        auto& moved_piece_bitboard =
        (us_color == Color::WHITE
             ? white_bitboards[undo_entry.moved_piece]
             : black_bitboards[undo_entry.moved_piece]);
        clearBit(moved_piece_bitboard, move.end);
        setBit(moved_piece_bitboard, move.start);
    }

    if (undo_entry.captured_piece < PieceTypeCount) {
        auto& captured_piece_bitboard =
        (opponent_color == Color::WHITE
             ? white_bitboards[undo_entry.captured_piece]
             : black_bitboards[undo_entry.captured_piece]);
        int restore_square_index =
            (move.type == MoveType::EN_PASSANT)
                ? (us_color == Color::WHITE ? move.end - 8 : move.end + 8)
                : move.end;
        setBit(captured_piece_bitboard, restore_square_index);
    }

    if (undo_entry.is_castling_move) {
        auto& rook_bitboard =
            (us_color == Color::WHITE ? white_bitboards[ROOK] : black_bitboards[ROOK]);
        clearBit(rook_bitboard, undo_entry.castling_rook_to_square);
        setBit(rook_bitboard, undo_entry.castling_rook_from_square);
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
    std::vector<Move> pseudo_legal_moves = generatePseudoMoves();

    std::cout << "Pseudo-legal moves (" << pseudo_legal_moves.size() << "):";
    for (const Move& move : pseudo_legal_moves) {
        std::cout << ' ' << move.toString();
    }
    std::cout << '\n';
}

void Board::printLegalMoves() const {
    std::vector<Move> legal_moves = generateLegalMoves();

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

Board::PieceIndex Board::getPieceAt(int square) const {
    uint64_t mask = 1ULL << square;

    uint64_t all_pieces =
        white_bitboards[PAWN] | white_bitboards[KNIGHT] | white_bitboards[BISHOP] |
        white_bitboards[ROOK] | white_bitboards[QUEEN] | white_bitboards[KING] |
        black_bitboards[PAWN] | black_bitboards[KNIGHT] | black_bitboards[BISHOP] |
        black_bitboards[ROOK] | black_bitboards[QUEEN] | black_bitboards[KING];

    if (!(all_pieces & mask)) {
        return PieceTypeCount;
    }

    for (int p = 0; p < PieceTypeCount; ++p) {
        if (testBit(white_bitboards[p], square)) return static_cast<PieceIndex>(p);
        if (testBit(black_bitboards[p], square)) return static_cast<PieceIndex>(p);
    }

    return PieceTypeCount;
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