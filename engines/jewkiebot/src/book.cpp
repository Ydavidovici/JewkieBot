#include "book.h"

#include <algorithm>
#include <cstring>
#include <fstream>

#include "board.h"
#include "polyglotRandom.h"
#include <bit>

namespace {

constexpr int polyPiece(Board::PieceIndex pt, Color c) {
    static_assert(Board::PAWN == 0 && Board::KNIGHT == 1 && Board::BISHOP == 2 && 
                  Board::ROOK == 3 && Board::QUEEN == 4 && Board::KING == 5,
                  "Board::PieceIndex enum values changed, polyglot piece hashing broken.");
    // Polyglot: BP=0,WP=1,BN=2,WN=3,BB=4,WB=5,BR=6,WR=7,BQ=8,WQ=9,BK=10,WK=11
    return 2 * static_cast<int>(pt) + (c == Color::WHITE ? 1 : 0);
}

uint64_t readBE64(const uint8_t* p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v = (v << 8) | p[i];
    return v;
}

uint16_t readBE16(const uint8_t* p) {
    return static_cast<uint16_t>((p[0] << 8) | p[1]);
}

uint32_t readBE32(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24)
         | (static_cast<uint32_t>(p[1]) << 16)
         | (static_cast<uint32_t>(p[2]) << 8)
         | static_cast<uint32_t>(p[3]);
}

}  // namespace

Book::Book() : rng_(std::random_device{}()) {}

uint64_t Book::polyglotKey(const Board& board) {
    uint64_t key = 0;

    for (int ci = 0; ci < 2; ++ci) {
        Color c = (ci == 0) ? Color::WHITE : Color::BLACK;
        for (int pt = 0; pt < Board::PieceTypeCount; ++pt) {
            auto piece = static_cast<Board::PieceIndex>(pt);
            uint64_t bb = board.pieceBB(c, piece);
            int piece_idx = polyPiece(piece, c);
            while (bb) {
                int sq = std::countr_zero(bb);
                bb &= bb - 1;
                key ^= polyglot::kRandom64[polyglot::kRandomPiece + 64 * piece_idx + sq];
            }
        }
    }

    uint8_t cr = board.castlingRights();
    if (cr & 0b0001) key ^= polyglot::kRandom64[polyglot::kRandomCastle + 0];
    if (cr & 0b0010) key ^= polyglot::kRandom64[polyglot::kRandomCastle + 1];
    if (cr & 0b0100) key ^= polyglot::kRandom64[polyglot::kRandomCastle + 2];
    if (cr & 0b1000) key ^= polyglot::kRandom64[polyglot::kRandomCastle + 3];

    // Polyglot only hashes ep if a capturing pawn of the side-to-move
    // actually sits on a file adjacent to the pushed pawn.
    int ep_sq = board.enPassantSquare();
    if (ep_sq != -1) {
        int ep_file = ep_sq % 8;
        Color stm = board.sideToMove();
        int pawn_rank = (stm == Color::WHITE) ? 4 : 3;
        uint64_t pawns = board.pieceBB(stm, Board::PAWN);
        bool capturable = false;
        if (ep_file > 0 && (pawns & (1ULL << (pawn_rank * 8 + (ep_file - 1))))) capturable = true;
        if (ep_file < 7 && (pawns & (1ULL << (pawn_rank * 8 + (ep_file + 1))))) capturable = true;
        if (capturable) {
            key ^= polyglot::kRandom64[polyglot::kRandomEnPassant + ep_file];
        }
    }

    if (board.sideToMove() == Color::WHITE) {
        key ^= polyglot::kRandom64[polyglot::kRandomTurn];
    }

    return key;
}

Move Book::decodeMove(uint16_t raw, const Board& board, const std::vector<Move>& legal) {
    int to_file   = (raw >> 0) & 0x7;
    int to_row    = (raw >> 3) & 0x7;
    int from_file = (raw >> 6) & 0x7;
    int from_row  = (raw >> 9) & 0x7;
    int promo     = (raw >> 12) & 0x7;

    int from_sq = from_row * 8 + from_file;
    int to_sq   = to_row * 8 + to_file;

    char promo_char = '\0';
    switch (promo) {
        case 1: promo_char = 'N'; break;
        case 2: promo_char = 'B'; break;
        case 3: promo_char = 'R'; break;
        case 4: promo_char = 'Q'; break;
        default: break;
    }

    // Polyglot encodes castling as king-takes-own-rook (e1h1, e1a1, e8h8, e8a8).
    // Remap to the standard two-square king destination so the legal-move list matches.
    bool castle_candidate =
        (from_sq == 4 && (to_sq == 7 || to_sq == 0)) ||
        (from_sq == 60 && (to_sq == 63 || to_sq == 56));
    if (castle_candidate && board.getPieceAt(from_sq) == Board::KING) {
        switch (to_sq) {
            case 7:  to_sq = 6;  break;
            case 0:  to_sq = 2;  break;
            case 63: to_sq = 62; break;
            case 56: to_sq = 58; break;
        }
    }

    for (const auto& m : legal) {
        if (m.start != from_sq || m.end != to_sq) continue;
        if (promo_char != '\0' && m.promo != promo_char) continue;
        if (promo_char == '\0' && m.type == MoveType::PROMOTION) continue;
        return m;
    }
    return Move();
}

bool Book::load(const std::string& path) {
    clear();

    std::ifstream f(path, std::ios::binary);
    if (!f) return false;

    f.seekg(0, std::ios::end);
    std::streamoff size = f.tellg();
    f.seekg(0, std::ios::beg);
    if (size <= 0 || size % 16 != 0) return false;

    const std::size_t count = static_cast<std::size_t>(size) / 16;
    std::vector<uint8_t> buf(static_cast<std::size_t>(size));
    if (!f.read(reinterpret_cast<char*>(buf.data()), size)) {
        return false;
    }

    entries_.resize(count);
    for (std::size_t i = 0; i < count; ++i) {
        const uint8_t* p = buf.data() + i * 16;
        entries_[i].key    = readBE64(p);
        entries_[i].move   = readBE16(p + 8);
        entries_[i].weight = readBE16(p + 10);
        entries_[i].learn  = readBE32(p + 12);
    }

    // Polyglot books are required to be sorted by key. Sort defensively in
    // case we ever load a book that isn't.
    if (!std::is_sorted(entries_.begin(), entries_.end(),
                        [](const Entry& a, const Entry& b) { return a.key < b.key; })) {
        std::sort(entries_.begin(), entries_.end(),
                  [](const Entry& a, const Entry& b) { return a.key < b.key; });
    }

    return true;
}

void Book::clear() {
    entries_.clear();
    entries_.shrink_to_fit();
}

std::vector<std::pair<Move, uint16_t>> Book::gatherLegal(uint64_t key, const Board& board) const {
    auto cmp = [](const Entry& e, uint64_t k) { return e.key < k; };
    auto lo = std::lower_bound(entries_.begin(), entries_.end(), key, cmp);

    std::vector<std::pair<Move, uint16_t>> out;
    auto legalMoves = board.generateLegalMoves();
    for (auto it = lo; it != entries_.end() && it->key == key; ++it) {
        Move m = decodeMove(it->move, board, legalMoves);
        if (m.isValid()) out.emplace_back(m, it->weight);
    }
    return out;
}

Move Book::probe(const Board& board) const {
    if (entries_.empty()) return Move();

    auto candidates = gatherLegal(polyglotKey(board), board);
    if (candidates.empty()) return Move();

    uint64_t total = 0;
    for (const auto& c : candidates) total += c.second;

    if (total == 0) return candidates.front().first;

    std::uniform_int_distribution<uint64_t> dist(0, total - 1);
    uint64_t pick = dist(rng_);
    uint64_t cum = 0;
    for (const auto& c : candidates) {
        cum += c.second;
        if (pick < cum) return c.first;
    }
    return candidates.back().first;
}

Move Book::probeBest(const Board& board) const {
    if (entries_.empty()) return Move();

    auto candidates = gatherLegal(polyglotKey(board), board);
    if (candidates.empty()) return Move();

    auto best = std::max_element(
        candidates.begin(), candidates.end(),
        [](const auto& a, const auto& b) { return a.second < b.second; });
    return best->first;
}
