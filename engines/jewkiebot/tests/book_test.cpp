#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>
#include "board.h"
#include "book.h"
#include "main.h"
#include "move.h"

#define REQUIRE(cond)                                                          \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cerr << "FAIL [" << __FILE__ << ":" << __LINE__               \
                      << "]: " #cond "\n";                                     \
            std::abort();                                                      \
        }                                                                      \
    } while (0)

#define REQUIRE_EQ_HEX(actual, expected)                                       \
    do {                                                                       \
        uint64_t _a = (actual);                                                \
        uint64_t _e = (expected);                                              \
        if (_a != _e) {                                                        \
            std::cerr << "FAIL [" << __FILE__ << ":" << __LINE__ << "]: "      \
                      << #actual << "\n  got      0x" << std::hex              \
                      << std::setw(16) << std::setfill('0') << _a              \
                      << "\n  expected 0x" << std::setw(16)                    \
                      << std::setfill('0') << _e << std::dec << "\n";          \
            std::abort();                                                      \
        }                                                                      \
    } while (0)

static Board boardFromFEN(const std::string& fen) {
    Board b;
    b.loadFEN(fen);
    return b;
}

static void test_key_startpos() {
    std::cout << "--- test_key_startpos ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x463b96181691fc9cULL);
    std::cout << "PASS\n\n";
}

static void test_key_after_e4() {
    std::cout << "--- test_key_after_e4 ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x823c9b50fd114196ULL);
    std::cout << "PASS\n\n";
}

static void test_key_after_e4_d5() {
    std::cout << "--- test_key_after_e4_d5 ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x0756b94461c50fb0ULL);
    std::cout << "PASS\n\n";
}

static void test_key_after_e4_d5_e5() {
    std::cout << "--- test_key_after_e4_d5_e5 ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x662fafb965db29d4ULL);
    std::cout << "PASS\n\n";
}

// ep file f, white STM, capturable (white pawn on e5 next to f5)
static void test_key_ep_capturable() {
    std::cout << "--- test_key_ep_capturable ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x22a48b5a8e47ff78ULL);
    std::cout << "PASS\n\n";
}

// White king moved to e2: white loses both castling rights.
static void test_key_castling_lost() {
    std::cout << "--- test_key_castling_lost ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPPKPPP/RNBQ1BNR b kq - 0 3");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x652a607ca3f242c1ULL);
    std::cout << "PASS\n\n";
}

static void test_key_both_kings_moved() {
    std::cout << "--- test_key_both_kings_moved ---\n";
    Board b = boardFromFEN(
        "rnbq1bnr/ppp1pkpp/8/3pPp2/8/8/PPPPKPPP/RNBQ1BNR w - - 0 4");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x00fdd303c946bdd9ULL);
    std::cout << "PASS\n\n";
}

// After 1.a4 b5 2.h4 b4 3.c4: ep square c3, black STM, black pawn on b4 CAN
// capture, so ep file IS hashed.
static void test_key_ep_with_capturable_after_c4() {
    std::cout << "--- test_key_ep_with_capturable_after_c4 ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/p1pppppp/8/8/PpP4P/8/1P1PPPP1/RNBQKBNR b KQkq c3 0 3");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x3c8123ea7b067637ULL);
    std::cout << "PASS\n\n";
}

static void test_key_after_ep_capture() {
    std::cout << "--- test_key_after_ep_capture ---\n";
    Board b = boardFromFEN(
        "rnbqkbnr/p1pppppp/8/8/P6P/R1p5/1P1PPPP1/1NBQKBNR b Kkq - 0 4");
    REQUIRE_EQ_HEX(Book::polyglotKey(b), 0x5c3f9b829b279560ULL);
    std::cout << "PASS\n\n";
}

static void test_decode_e2e4() {
    std::cout << "--- test_decode_e2e4 ---\n";
    Board b;  // start position
    // from=e2 (row=1,file=4 -> 12), to=e4 (row=3,file=4 -> 28), no promo
    // raw = (0 << 12) | (1 << 9) | (4 << 6) | (3 << 3) | 4
    uint16_t raw = (1u << 9) | (4u << 6) | (3u << 3) | 4u;
    Move m = Book::decodeMove(raw, b);
    REQUIRE(m.isValid());
    REQUIRE(m.start == 12);
    REQUIRE(m.end == 28);
    REQUIRE(m.type != MoveType::PROMOTION);
    REQUIRE(m.toString() == "e2e4");
    std::cout << "PASS\n\n";
}

static void test_decode_castle_kingside() {
    std::cout << "--- test_decode_castle_kingside ---\n";
    Board b = boardFromFEN(
        "r3k2r/pppq1ppp/2np1n2/2b1p1B1/2B1P3/2NP1N2/PPPQ1PPP/R3K2R w KQkq - 0 1");
    // Polyglot encodes white short-castle as king-takes-h1-rook: e1->h1.
    // raw = from=e1=4, to=h1=7 -> (0 << 9) | (4 << 6) | (0 << 3) | 7
    uint16_t raw = (0u << 9) | (4u << 6) | (0u << 3) | 7u;
    Move m = Book::decodeMove(raw, b);
    REQUIRE(m.isValid());
    REQUIRE(m.type == MoveType::CASTLE_KINGSIDE);
    REQUIRE(m.start == 4);
    REQUIRE(m.end == 6);  // standard 2-square king destination
    std::cout << "PASS\n\n";
}

static void test_decode_promotion_queen() {
    std::cout << "--- test_decode_promotion_queen ---\n";
    // Pawn on b7 with empty b8 (king on e8 doesn't block).
    Board b = boardFromFEN("4k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
    // from=b7=49 (row=6,file=1), to=b8=57 (row=7,file=1), promo=4 (Q)
    uint16_t raw = (4u << 12) | (6u << 9) | (1u << 6) | (7u << 3) | 1u;
    Move m = Book::decodeMove(raw, b);
    REQUIRE(m.isValid());
    REQUIRE(m.type == MoveType::PROMOTION);
    REQUIRE(m.promo == 'Q');
    REQUIRE(m.start == 49);
    REQUIRE(m.end == 57);
    std::cout << "PASS\n\n";
}

// -- Transposition: same position via two move orders has the same key --

static void test_transposition_same_key() {
    std::cout << "--- test_transposition_same_key ---\n";
    Board a;
    a.makeMove(Move::fromUCI("e2e4"));
    a.makeMove(Move::fromUCI("e7e5"));
    a.makeMove(Move::fromUCI("g1f3"));
    a.makeMove(Move::fromUCI("b8c6"));

    Board b;
    b.makeMove(Move::fromUCI("g1f3"));
    b.makeMove(Move::fromUCI("b8c6"));
    b.makeMove(Move::fromUCI("e2e4"));
    b.makeMove(Move::fromUCI("e7e5"));

    REQUIRE_EQ_HEX(Book::polyglotKey(a), Book::polyglotKey(b));
    std::cout << "PASS\n\n";
}

static void writeBE(std::ofstream& ofs, uint64_t v, int bytes) {
    for (int i = bytes - 1; i >= 0; --i) {
        ofs.put(static_cast<char>((v >> (8 * i)) & 0xff));
    }
}

static std::string makeTempBook(const std::vector<std::tuple<uint64_t, uint16_t, uint16_t>>& entries) {
    static int counter = 0;
    const char* tmpdir = std::getenv("TEMP");
    if (!tmpdir) tmpdir = std::getenv("TMP");
    if (!tmpdir) tmpdir = std::getenv("TMPDIR");
    if (!tmpdir) tmpdir = ".";
    std::string path = std::string(tmpdir) + "/chess_book_test_" +
                       std::to_string(++counter) + ".bin";
    std::ofstream ofs(path, std::ios::binary);
    for (auto& [key, move, weight] : entries) {
        writeBE(ofs, key, 8);
        writeBE(ofs, move, 2);
        writeBE(ofs, weight, 2);
        writeBE(ofs, 0, 4);  // learn
    }
    ofs.close();
    return path;
}

static void test_load_and_probe() {
    std::cout << "--- test_load_and_probe ---\n";
    uint16_t e2e4 = (1u << 9) | (4u << 6) | (3u << 3) | 4u;
    auto path = makeTempBook({{0x463b96181691fc9cULL, e2e4, 100}});

    Book book;
    REQUIRE(book.load(path));
    REQUIRE(book.isLoaded());
    REQUIRE(book.size() == 1);

    Board b;
    Move m = book.probe(b);
    REQUIRE(m.isValid());
    REQUIRE(m.toString() == "e2e4");

    std::remove(path.c_str());
    std::cout << "PASS\n\n";
}

static void test_probe_weighted_picks_only_legal() {
    std::cout << "--- test_probe_weighted_picks_only_legal ---\n";
    // Two startpos entries: e2e4 (weight 100) and a bogus illegal move
    // (e1h8 from king to corner -- not legal). Weighted random must
    // never return the illegal one.
    uint16_t e2e4 = (1u << 9) | (4u << 6) | (3u << 3) | 4u;
    uint16_t bogus = (0u << 9) | (4u << 6) | (7u << 3) | 7u;  // e1->h8
    auto path = makeTempBook({{0x463b96181691fc9cULL, e2e4, 100},
                              {0x463b96181691fc9cULL, bogus, 100}});

    Book book;
    book.seed(42);
    REQUIRE(book.load(path));

    Board b;
    for (int i = 0; i < 50; ++i) {
        Move m = book.probe(b);
        REQUIRE(m.isValid());
        REQUIRE(m.toString() == "e2e4");
    }

    std::remove(path.c_str());
    std::cout << "PASS\n\n";
}

static void test_probe_miss_returns_invalid() {
    std::cout << "--- test_probe_miss_returns_invalid ---\n";
    // Book has only startpos; probe an unrelated position.
    uint16_t e2e4 = (1u << 9) | (4u << 6) | (3u << 3) | 4u;
    auto path = makeTempBook({{0x463b96181691fc9cULL, e2e4, 100}});

    Book book;
    REQUIRE(book.load(path));

    Board b = boardFromFEN("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    Move m = book.probe(b);
    REQUIRE(!m.isValid());

    std::remove(path.c_str());
    std::cout << "PASS\n\n";
}

// Verify the engine cutoff: position at fullmove > BookMaxFullmove
// must not consult the book. We assert the precondition (fullmoveNumber
// accessor) the cutoff logic in Engine::playMove relies on.
// TODO: this only verifies the precondition, not the actual cutoff behaviour.
// Add an integration test: load a book, set book_max_fullmove=1, advance to
// move 2, call playMove, and assert a search result is returned (not a book move).
static void test_cutoff_accessor() {
    std::cout << "--- test_cutoff_accessor ---\n";
    Engine eng;
    REQUIRE(eng.setPosition(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 25"));
    REQUIRE(eng.getBoard().fullmoveNumber() == 25);
    REQUIRE(eng.bookMaxFullmove() == 20);
    REQUIRE(eng.getBoard().fullmoveNumber() > eng.bookMaxFullmove());
    std::cout << "PASS\n\n";
}

// Transposition through the book: load entries keyed for two distinct
// move orders that reach the same position; probing either order picks
// the configured move.
static void test_book_transposition() {
    std::cout << "--- test_book_transposition ---\n";
    Board a;
    a.makeMove(Move::fromUCI("e2e4"));
    a.makeMove(Move::fromUCI("e7e5"));
    a.makeMove(Move::fromUCI("g1f3"));
    a.makeMove(Move::fromUCI("b8c6"));

    Board b;
    b.makeMove(Move::fromUCI("g1f3"));
    b.makeMove(Move::fromUCI("b8c6"));
    b.makeMove(Move::fromUCI("e2e4"));
    b.makeMove(Move::fromUCI("e7e5"));

    uint64_t key = Book::polyglotKey(a);
    REQUIRE(key == Book::polyglotKey(b));

    // Bf1-c4 from this position: from=f1=5, to=c4=26
    uint16_t bc4 = (0u << 9) | (5u << 6) | (3u << 3) | 2u;
    auto path = makeTempBook({{key, bc4, 100}});

    Book book;
    REQUIRE(book.load(path));

    Move ma = book.probe(a);
    Move mb = book.probe(b);
    REQUIRE(ma.isValid());
    REQUIRE(mb.isValid());
    REQUIRE(ma.toString() == "f1c4");
    REQUIRE(mb.toString() == "f1c4");

    std::remove(path.c_str());
    std::cout << "PASS\n\n";
}

int main() {
    test_key_startpos();
    test_key_after_e4();
    test_key_after_e4_d5();
    test_key_after_e4_d5_e5();
    test_key_ep_capturable();
    test_key_castling_lost();
    test_key_both_kings_moved();
    test_key_ep_with_capturable_after_c4();
    test_key_after_ep_capture();

    test_decode_e2e4();
    test_decode_castle_kingside();
    test_decode_promotion_queen();

    test_transposition_same_key();

    test_load_and_probe();
    test_probe_weighted_picks_only_legal();
    test_probe_miss_returns_invalid();
    test_book_transposition();

    test_cutoff_accessor();

    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
