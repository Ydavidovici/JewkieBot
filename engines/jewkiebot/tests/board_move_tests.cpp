#include "board.h"
#include "move.h"
#include "types.h"

#include <cassert>
#include <cctype>
#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
#include <unordered_set>

using std::string;
using std::vector;


static bool contains(const vector<string>& v, const string& s) {
    return std::find(v.begin(), v.end(), s) != v.end();
}
static bool starts_with(const string& s, const string& pref) {
    return s.size() >= pref.size() && s.compare(0, pref.size(), pref) == 0;
}
static int sq_from(const string& sq) {
    int f = sq[0] - 'a';
    int r = sq[1] - '1';
    return r*8 + f;
}
static vector<string> to_uci(const vector<Move>& mv) {
    vector<string> out; out.reserve(mv.size());
    for (auto& m : mv) out.push_back(m.toString());
    return out;
}
static vector<string> gen_uci(const Board& b) {
    return to_uci(b.generateLegalMoves());
}
static vector<string> moves_from(const Board& b, const string& from) {
    int s = sq_from(from);
    vector<string> out;
    for (auto& m : b.generateLegalMoves()) {
        if (m.start == s) out.push_back(m.toString());
    }
    std::sort(out.begin(), out.end());
    return out;
}
static void dump_moves(const string& label, const vector<string>& mv) {
    std::cout << label << " (" << mv.size() << "): ";
    for (auto& s : mv) std::cout << s << "  ";
    std::cout << "\n";
}

Move find_move(const Board& b, const std::string& uci) {
    auto moves = b.generateLegalMoves();
    for (const auto& m : moves) {
        if (m.toString() == uci) return m;
    }
    std::cerr << "Error: Move " << uci << " not found or illegal!\n";
    return Move();
}

static void test_move_roundtrip() {
    std::cout << "--- test_move_roundtrip ---\n";

    vector<string> FENS = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "8/8/8/8/3Q4/8/8/8 w - - 0 1",
        "8/8/8/8/3P4/8/8/8 w - - 0 1",
        "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 2 3"
    };

    for (auto& F : FENS) {
        Board b; b.loadFEN(F);
        auto mv = b.generateLegalMoves();
        for (auto& m : mv) {
            auto s = m.toString();
            Move back = Move::fromUCI(s);
            assert(back.isValid());
            assert(back.start == m.start && back.end == m.end && back.promo == m.promo);
        }
    }
    std::cout << "  ok move UCI round-trip across positions\n\n";
}

static void test_pawn_push_capture_promo() {
    std::cout << "--- test_pawn_push_capture_promo ---\n";
    {
        Board b; b.loadFEN("7k/8/8/8/8/8/4P3/K7 w - - 0 1");
        auto v = gen_uci(b);
        dump_moves("e2-only", v);
        assert(contains(v,"e2e3"));
        assert(contains(v,"e2e4"));
    }
    {
        Board b; b.loadFEN("8/8/8/8/4P3/4p3/8/8 b - - 0 1"); // just ensures no crash, sanity case
        auto v = gen_uci(b);
        (void)v;
    }
    {
        Board b; b.loadFEN("8/p6P/8/8/8/8/8/8 b - - 0 1"); // black pawn a7; white pawn h7 to tempt wrap
        auto from_a7 = moves_from(b,"a7");
        dump_moves("a7-moves", from_a7);
        assert(from_a7.size() == 2);
        assert(contains(from_a7,"a7a6"));
        assert(contains(from_a7,"a7a5"));
        for (auto& s : from_a7) assert(!starts_with(s,"a7h")); // no wrap
    }
    {
        Board b; b.loadFEN("k6r/6Pp/8/8/8/8/8/6K1 w - - 0 1");
        auto v = gen_uci(b);
        dump_moves("promo", v);
        assert(contains(v,"g7g8Q"));
        assert(contains(v,"g7g8R"));
        assert(contains(v,"g7g8B"));
        assert(contains(v,"g7g8N"));
        assert(contains(v,"g7h8Q"));
        assert(contains(v,"g7h8R"));
        assert(contains(v,"g7h8B"));
        assert(contains(v,"g7h8N"));
    }
    std::cout << "  ok pawn pushes/captures/promotions\n\n";
}

static void test_knight_moves_wrap_guard() {
    std::cout << "--- test_knight_moves_wrap_guard ---\n";
    {
        Board b; b.loadFEN("8/8/8/8/8/8/8/N7 w - - 0 1");
        auto v = gen_uci(b);
        dump_moves("N@a1", v);
        assert(contains(v,"a1b3"));
        assert(contains(v,"a1c2"));
        for (auto& s : v) {
            int s0 = sq_from(s.substr(0,2)), s1 = sq_from(s.substr(2,2));
            int df = std::abs((s1%8)-(s0%8));
            int dr = std::abs((s1/8)-(s0/8));
            assert((df==1 && dr==2) || (df==2 && dr==1));
        }
    }
    {
        Board b;
        auto v = gen_uci(b);
        for (auto& s : v) {
            if (starts_with(s,"g1")) {
                assert(s=="g1e2" || s=="g1f3" || s=="g1h3");
            }
        }
    }
    std::cout << "  ok knight wrap guard\n\n";
}

static void test_sliding_edges() {
    std::cout << "--- test_sliding_edges ---\n";
    {
        Board b; b.loadFEN("8/8/8/8/3R4/8/8/8 w - - 0 1");
        auto v = gen_uci(b);
        dump_moves("R@d4", v);
        assert(contains(v,"d4d8"));
        assert(contains(v,"d4d1"));
        assert(contains(v,"d4a4"));
        assert(contains(v,"d4h4"));
    }
    {
        Board b; b.loadFEN("8/8/8/8/3B4/8/8/8 w - - 0 1");
        auto v = gen_uci(b);
        dump_moves("B@d4", v);
        assert(contains(v,"d4a7"));
        assert(contains(v,"d4g7"));
        assert(contains(v,"d4a1"));
        assert(contains(v,"d4g1"));
    }
    std::cout << "  ok sliding edges\n\n";
}

static void test_king_safety_and_no_king_captures() {
    std::cout << "--- test_king_safety_and_no_king_captures ---\n";
    {
        Board b; b.loadFEN("8/8/8/8/4K3/8/8/8 w - - 0 1");
        auto v = gen_uci(b);
        dump_moves("K@e4", v);
        for (auto sq:{"d5","e5","f5","d4","f4","d3","e3","f3"})
            assert(contains(v, string("e4")+sq));
    }
    {
        Board b; b.loadFEN("8/8/8/8/8/8/5r2/4K3 w - - 0 1");
        auto v = gen_uci(b);
        dump_moves("K@e1 w/ Rf2", v);
        assert(!contains(v,"e1f1"));
        assert(contains(v,"e1d1"));
    }
    {
        Board b; b.loadFEN("8/8/8/8/8/8/8/4K2k w - - 0 1");
        auto mv = b.generateLegalMoves();
        int blackKing = sq_from("h1");
        for (auto& m : mv) {
            assert(m.end != blackKing);
        }
    }
    std::cout << "  ok king safety & no king-captures\n\n";
}

static void test_castling_rules() {
    std::cout << "--- test_castling_rules ---\n";
    {
        Board b; b.loadFEN("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
        auto v = gen_uci(b);
        dump_moves("castle both sides", v);
        assert(contains(v,"e1g1"));
        assert(contains(v,"e1c1"));
    }
    {
        Board b; b.loadFEN("4r3/8/8/8/8/8/8/4K2R w K - 0 1");
        auto v = gen_uci(b);
        dump_moves("castle while in check", v);
        assert(!contains(v,"e1g1"));
    }
    {
        Board b; b.loadFEN("8/5r2/8/8/8/8/8/4K2R w K - 0 1");
        auto v = gen_uci(b);
        dump_moves("castle through check (should be illegal)", v);
        assert(!contains(v,"e1g1"));
    }

    {
        Board b; b.loadFEN("k7/8/8/8/8/8/8/4K2R w K - 0 1");

        Move m1 = find_move(b, "h1h2");
        bool ok1 = b.makeMove(m1); assert(ok1);

        Move m2 = find_move(b, "a8a7");
        bool ok2 = b.makeMove(m2); assert(ok2);

        Move m3 = find_move(b, "h2h1");
        bool ok3 = b.makeMove(m3); assert(ok3);

        auto v = gen_uci(b);
        dump_moves("rights after rook moved-away-and-back", v);
        assert(!contains(v,"e1g1"));
    }
    std::cout << "  ok castling rules\n\n";
}

static void test_en_passant_rules() {
    std::cout << "--- test_en_passant_rules ---\n";
    Board b; b.loadFEN("k7/3p4/8/4P3/8/8/8/4K3 b - - 0 1");
    assert(b.makeMove(Move::fromUCI("d7d5")));
    auto v = gen_uci(b);
    dump_moves("EP enabled", v);
    bool foundEP=false;
    for (auto& m : b.generateLegalMoves()) {
        if (m.type==MoveType::EN_PASSANT && m.toString()=="e5d6") foundEP = true;
    }
    assert(foundEP);

    assert(b.makeMove(Move::fromUCI("e1d1")));
    auto v2 = gen_uci(b);
    for (auto& m : b.generateLegalMoves()) {
        assert(!(m.type==MoveType::EN_PASSANT && m.toString()=="e5d6"));
    }
    std::cout << "  ok en passant immediate-only\n\n";
}

static void test_pins_and_illegal_due_to_self_check() {
    std::cout << "--- test_pins_and_illegal_due_to_self_check ---\n";
    Board b; b.loadFEN("4r3/8/8/8/8/8/4P3/4K3 w - - 0 1");
    auto v = gen_uci(b);
    dump_moves("pin test", v);

    assert(!contains(v, "e2d3"));
    assert(!contains(v, "e2f3"));

    assert(contains(v, "e2e3"));
    assert(contains(v, "e2e4"));

    std::cout << "  ok pinned piece can't move if it exposes check\n\n";
}

static void test_make_unmake_integrity() {
    std::cout << "--- test_make_unmake_integrity ---\n";
    {
        Board b; b.loadFEN("8/8/8/8/8/8/4P3/8 w - - 0 1");
        Move m = Move::fromUCI("e2e4");
        auto fen_before = b.toFEN();

        bool ok = b.makeMove(m);
        assert(ok);

        b.unmakeMove();
        assert(b.toFEN() == fen_before);
    }
    {
        Board b; b.loadFEN("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
        Move ck = find_move(b, "e1g1");
        auto fen_before = b.toFEN();

        bool ok = b.makeMove(ck);
        assert(ok);

        b.unmakeMove();
        assert(b.toFEN() == fen_before);
    }
    std::cout << "  ok make/unmake round-trip\n\n";
}

static void test_draw_and_material_detectors() {
    std::cout << "--- test_draw_and_material_detectors ---\n";
    {
        Board b; b.loadFEN("8/8/8/8/8/8/8/K6k w - - 0 1");
        assert(b.isInsufficientMaterial());
    }
    {
        Board b; b.loadFEN("8/8/8/8/8/8/8/K6k w - - 0 1");
        for (int i=0;i<50;i++){
            bool m1 = b.makeMove(Move::fromUCI("a1a2"));
            bool m2 = b.makeMove(Move::fromUCI("h1h2"));

            (void)m1; (void)m2;

            b.unmakeMove(); b.unmakeMove();
        }
    }
    std::cout << "  ok insufficient material\n\n";
}

static void test_no_bogus_moves_from_scholar_fen() {
    std::cout << "--- test_no_bogus_moves_from_scholar_fen ---\n";
    const string scholar = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 2 3";
    Board b; b.loadFEN(scholar);
    auto from_a7 = moves_from(b, "a7");
    dump_moves("a7 from scholar FEN", from_a7);
    assert(from_a7.size() == 2);
    assert(contains(from_a7,"a7a6"));
    assert(contains(from_a7,"a7a5"));
    for (auto& s : from_a7) assert(!starts_with(s,"a7h"));
    std::cout << "  ok a7 only a7a6/a7a5\n\n";
}

int main() {
    test_move_roundtrip();

    test_pawn_push_capture_promo();
    test_knight_moves_wrap_guard();
    test_sliding_edges();
    test_king_safety_and_no_king_captures();

    test_castling_rules();
    test_en_passant_rules();
    test_pins_and_illegal_due_to_self_check();

    test_make_unmake_integrity();
    test_draw_and_material_detectors();

    test_no_bogus_moves_from_scholar_fen();

    std::cout << "ALL BOARD/MOVE TESTS PASSED\n";
    return 0;
}
