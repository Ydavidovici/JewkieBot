/**
 * eval_test.cpp
 *
 * Full evaluator test suite.  Sections:
 *
 *  1. Material values    – each piece type has the expected raw value
 *  2. PST bonuses        – piece-square tables produce expected score deltas
 *  3. Evaluator properties – perspective consistency, symmetry, boundedness
 *  4. Terminal detection – checkmate and stalemate return correct scores
 */

#include <iostream>
#include <cmath>
#include <cassert>
#include "evaluator.h"
#include "board.h"


// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

static Evaluator g_ev;

static int eval(const char* fen, Color side = Color::WHITE) {
    Board b; b.loadFEN(fen);
    return g_ev.evaluate(b, side);
}

static void expect_range(int score, int lo, int hi, const char* label) {
    if (score < lo || score > hi) {
        std::cerr << "FAIL " << label
                  << ": score=" << score
                  << " not in [" << lo << ", " << hi << "]\n";
        std::exit(1);
    }
    std::cout << "  PASS " << label << " (score=" << score << ")\n";
}

static void expect_gt(int a, int b, const char* label) {
    if (!(a > b)) {
        std::cerr << "FAIL " << label << ": " << a << " not > " << b << "\n";
        std::exit(1);
    }
    std::cout << "  PASS " << label << " (" << a << " > " << b << ")\n";
}

static void expect_eq(int a, int b, const char* label) {
    if (a != b) {
        std::cerr << "FAIL " << label << ": " << a << " != " << b << "\n";
        std::exit(1);
    }
    std::cout << "  PASS " << label << " (" << a << " == " << b << ")\n";
}


// ===========================================================================
// SECTION 1 – Material values
// ===========================================================================

// Start position (symmetric) → score ≈ 0
static void test_material_start_position() {
    std::cout << "--- test_material_start_position ---\n";

    int s = eval("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    std::cout << "  start score=" << s << "\n";
    expect_range(s, -50, 50, "start position");
    std::cout << "\n";
}

// White up one pawn: score from white's view ≈ +100 ± PST
static void test_material_up_pawn() {
    std::cout << "--- test_material_up_pawn ---\n";

    // Both kings symmetric (a1 / a8), white has extra Pa2
    int s = eval("k7/8/8/8/8/8/P7/K7 w - - 0 1");
    expect_range(s, 60, 160, "white up 1 pawn");

    // Same from black's view: should be negative
    int sb = eval("k7/8/8/8/8/8/P7/K7 w - - 0 1", Color::BLACK);
    expect_range(sb, -160, -60, "black pov: down 1 pawn");
    std::cout << "\n";
}

// White up one knight: score ≈ +320 ± PST
static void test_material_up_knight() {
    std::cout << "--- test_material_up_knight ---\n";

    // White Ka1 + Nb1, Black Ka8
    int s = eval("k7/8/8/8/8/8/8/KN6 w - - 0 1");
    // Knight on b1 has PST penalty, but material advantage is ~320
    expect_range(s, 220, 400, "white up 1 knight");
    std::cout << "\n";
}

// White up one bishop: score ≈ +330 ± PST
static void test_material_up_bishop() {
    std::cout << "--- test_material_up_bishop ---\n";

    int s = eval("k7/8/8/8/8/8/8/KB6 w - - 0 1");
    expect_range(s, 240, 410, "white up 1 bishop");
    std::cout << "\n";
}

// White up one rook: score ≈ +500 ± PST
static void test_material_up_rook() {
    std::cout << "--- test_material_up_rook ---\n";

    int s = eval("k7/8/8/8/8/8/8/KR6 w - - 0 1");
    expect_range(s, 420, 560, "white up 1 rook");
    std::cout << "\n";
}

// White up one queen: score ≈ +900 ± PST
static void test_material_up_queen() {
    std::cout << "--- test_material_up_queen ---\n";

    int s = eval("k7/8/8/8/8/8/8/KQ6 w - - 0 1");
    expect_range(s, 820, 980, "white up 1 queen");
    std::cout << "\n";
}

// Relative ordering: queen > rook > bishop ≈ knight > pawn
static void test_material_piece_ordering() {
    std::cout << "--- test_material_piece_ordering ---\n";

    int pawn   = eval("k7/8/8/8/8/8/P7/K7 w - - 0 1");
    int knight = eval("k7/8/8/8/8/8/8/KN6 w - - 0 1");
    int bishop = eval("k7/8/8/8/8/8/8/KB6 w - - 0 1");
    int rook   = eval("k7/8/8/8/8/8/8/KR6 w - - 0 1");
    int queen  = eval("k7/8/8/8/8/8/8/KQ6 w - - 0 1");

    expect_gt(knight, pawn,   "knight > pawn");
    expect_gt(bishop, pawn,   "bishop > pawn");
    expect_gt(rook,   bishop, "rook > bishop");
    expect_gt(queen,  rook,   "queen > rook");
    std::cout << "\n";
}


// ===========================================================================
// SECTION 2 – Piece-square table bonuses
// ===========================================================================

// Pawn on e6 (rank 6) must score higher than pawn on e2 (rank 2).
// PST values (whitePawnTable): e2=-20, e6=+80 → delta ≈ +100.
static void test_pst_pawn_advancement() {
    std::cout << "--- test_pst_pawn_advancement ---\n";

    int scoreE2 = eval("k7/8/8/8/8/8/4P3/K7 w - - 0 1");  // e2: PST=-20
    int scoreE6 = eval("k7/4P3/8/8/8/8/8/K7 w - - 0 1");  // e6: PST=+80

    std::cout << "  pawn@e2=" << scoreE2 << "  pawn@e6=" << scoreE6 << "\n";
    expect_gt(scoreE6, scoreE2, "advanced pawn (e6) > starting pawn (e2)");
    std::cout << "\n";
}

// Central pawn (e5/d5) must score higher than wing pawn on same rank.
// PST: e5=+60, a5=+5 → delta ≈ 55.
static void test_pst_pawn_center_beats_wing() {
    std::cout << "--- test_pst_pawn_center_beats_wing ---\n";

    int center = eval("k7/8/8/4P3/8/8/8/K7 w - - 0 1");  // e5: PST=60
    int wing   = eval("k7/8/8/P7/8/8/8/K7 w - - 0 1");   // a5: PST=5

    std::cout << "  center pawn=" << center << "  wing pawn=" << wing << "\n";
    expect_gt(center, wing, "center pawn (e5) > wing pawn (a5)");
    std::cout << "\n";
}

// Knight in the center (e4) must score higher than knight on the rim (a1).
// PST: e4=+20, a1=-50.
static void test_pst_knight_center_vs_rim() {
    std::cout << "--- test_pst_knight_center_vs_rim ---\n";

    int center = eval("k7/8/8/8/4N3/8/8/K7 w - - 0 1");  // Ne4: PST=20
    int rim    = eval("k7/8/8/8/8/8/8/KN6 w - - 0 1");   // Nb1: PST=-40

    std::cout << "  center knight=" << center << "  rim knight=" << rim << "\n";
    expect_gt(center, rim, "center knight > rim knight");
    std::cout << "\n";
}

// Active bishop on long diagonal (c4) must score higher than corner bishop (a1).
// PST: c4=+5, a1=-20.
static void test_pst_bishop_active_vs_corner() {
    std::cout << "--- test_pst_bishop_active_vs_corner ---\n";

    int active = eval("k7/8/8/8/2B5/8/8/K7 w - - 0 1");  // Bc4: PST=5
    int corner = eval("k7/8/8/8/8/8/8/KB6 w - - 0 1");   // Bb1: PST=-10

    std::cout << "  active bishop=" << active << "  corner bishop=" << corner << "\n";
    expect_gt(active, corner, "active bishop (c4) > edge bishop (b1)");
    std::cout << "\n";
}

// Rook on rank 2 (d2) must score higher than rook on the rim files.
// The PST rewards rank-2 placement (+10) over rank-6 (-5).
static void test_pst_rook_rank_2_bonus() {
    std::cout << "--- test_pst_rook_rank_2_bonus ---\n";

    int rank2 = eval("k7/8/8/8/8/8/3R4/K7 w - - 0 1");  // Rd2: PST=10
    int rank6 = eval("k7/8/3R4/8/8/8/8/K7 w - - 0 1");  // Rd6: PST=-5

    std::cout << "  rook@rank2=" << rank2 << "  rook@rank6=" << rank6 << "\n";
    expect_gt(rank2, rank6, "rook on rank 2 > rook on rank 6 (per PST)");
    std::cout << "\n";
}

// Queen in the centre (d4) should score ≥ queen on the rim (a1).
static void test_pst_queen_center_vs_rim() {
    std::cout << "--- test_pst_queen_center_vs_rim ---\n";

    int center = eval("k7/8/8/8/3Q4/8/8/K7 w - - 0 1");  // Qd4
    int rim    = eval("k7/8/8/8/8/8/8/KQ6 w - - 0 1");   // Qb1

    std::cout << "  center queen=" << center << "  rim queen=" << rim << "\n";
    // The queen PST rewards d4 over b1 (both should be close, but center >= rim)
    assert(center >= rim && "centre queen must score >= rim queen");
    std::cout << "  PASS queen center >= queen rim\n\n";
}


// ===========================================================================
// SECTION 3 – Evaluator properties
// ===========================================================================

// evaluate(pos, white) == -evaluate(pos, black) for any position.
static void test_property_perspective_negation() {
    std::cout << "--- test_property_perspective_negation ---\n";

    const char* fens[] = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1",
        "k7/8/8/8/8/8/8/KR6 w - - 0 1",
        "k7/8/8/8/3Q4/8/8/K7 w - - 0 1",
    };

    for (auto fen : fens) {
        Board b; b.loadFEN(fen);
        int sw = g_ev.evaluate(b, Color::WHITE);
        int sb = g_ev.evaluate(b, Color::BLACK);
        std::cout << "  sw=" << sw << "  sb=" << sb << "\n";
        expect_eq(sw, -sb, "evaluate(white) == -evaluate(black)");
    }
    std::cout << "\n";
}

// Mirrored positions must produce the same score (for all piece types).
static void test_property_symmetry_all_pieces() {
    std::cout << "--- test_property_symmetry_all_pieces ---\n";

    struct Case { const char* white_advantage; const char* black_advantage; const char* label; };
    Case cases[] = {
        // White has extra pawn (a2)    / Black has extra pawn (a7)
        { "k7/8/8/8/8/8/P7/K7 w - - 0 1",
          "k7/p7/8/8/8/8/8/K7 b - - 0 1", "pawn symmetry" },
        // White has extra knight (b1) / Black has extra knight (b8)
        { "k7/8/8/8/8/8/8/KN6 w - - 0 1",
          "kn6/8/8/8/8/8/8/K7 b - - 0 1", "knight symmetry" },
        // White has extra bishop      / Black has extra bishop
        { "k7/8/8/8/8/8/8/KB6 w - - 0 1",
          "kb6/8/8/8/8/8/8/K7 b - - 0 1", "bishop symmetry" },
        // White has extra rook        / Black has extra rook
        { "k7/8/8/8/8/8/8/KR6 w - - 0 1",
          "kr6/8/8/8/8/8/8/K7 b - - 0 1", "rook symmetry" },
        // White has extra queen       / Black has extra queen
        { "k7/8/8/8/8/8/8/KQ6 w - - 0 1",
          "kq6/8/8/8/8/8/8/K7 b - - 0 1", "queen symmetry" },
    };

    for (auto& c : cases) {
        int sw = eval(c.white_advantage, Color::WHITE);
        int sb = eval(c.black_advantage, Color::BLACK);
        std::cout << "  [" << c.label << "] sw=" << sw << "  sb=" << sb << "\n";
        expect_eq(sw, sb, c.label);
    }
    std::cout << "\n";
}

// Raw eval must never exceed MATE_SCORE (100 000).
// Use the most extreme lopsided-material position imaginable.
static void test_property_score_bounded() {
    std::cout << "--- test_property_score_bounded ---\n";

    static constexpr int MATE_SCORE = 100000;

    const char* extreme = "qqqqqk2/qqqqqqqq/qqqqqqqq/8/8/8/8/7K w - - 0 1";
    Board b; b.loadFEN(extreme);
    int s = std::abs(g_ev.evaluate(b, Color::WHITE));
    std::cout << "  extreme material score=" << s << "\n";

    assert(s < MATE_SCORE && "raw material+PST eval must never reach MATE_SCORE");
    std::cout << "  PASS score bounded\n\n";
}

// Equal-material positions must produce near-zero scores.
static void test_property_equal_material_near_zero() {
    std::cout << "--- test_property_equal_material_near_zero ---\n";

    const char* fens[] = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "4k3/8/8/8/8/8/8/4K3 w - - 0 1",   // K vs K
        "4k3/4r3/8/8/8/8/4R3/4K3 w - - 0 1",  // KR vs KR
        "4k3/3q4/8/8/8/8/3Q4/4K3 w - - 0 1",  // KQ vs KQ
    };

    for (auto fen : fens) {
        int s = eval(fen);
        std::cout << "  score=" << s << "  [" << fen << "]\n";
        // Allow up to ±100 for PST asymmetry between the two king positions
        expect_range(s, -200, 200, "equal material near zero");
    }
    std::cout << "\n";
}


// ===========================================================================
// SECTION 4 – Terminal detection
// ===========================================================================

static void test_terminal_checkmate() {
    std::cout << "--- test_terminal_checkmate ---\n";

    // Black king is checkmated (Qg7# with Kg6 support)
    Board b; b.loadFEN("6k1/6Q1/6K1/8/8/8/8/8 b - - 0 1");
    int score = Evaluator::evaluateTerminal(b, Color::BLACK);
    std::cout << "  checkmate score=" << score << "\n";

    expect_eq(score, -100000, "checkmate must return -100000");
    std::cout << "\n";
}

static void test_terminal_stalemate() {
    std::cout << "--- test_terminal_stalemate ---\n";

    // Classic stalemate: black to move has no legal moves but is not in check
    Board b; b.loadFEN("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
    int score = Evaluator::evaluateTerminal(b, Color::BLACK);
    std::cout << "  stalemate score=" << score << "\n";

    // evaluateTerminal returns 0 when not in checkmate (stalemate/other)
    expect_eq(score, 0, "stalemate must return 0");
    std::cout << "\n";
}

static void test_terminal_non_terminal_returns_zero() {
    std::cout << "--- test_terminal_non_terminal_returns_zero ---\n";

    Board b;  // starting position: not checkmate, not stalemate
    int score = Evaluator::evaluateTerminal(b, Color::WHITE);
    std::cout << "  non-terminal score=" << score << "\n";

    expect_eq(score, 0, "non-terminal position must return 0 from evaluateTerminal");
    std::cout << "\n";
}


// ===========================================================================
// main
// ===========================================================================

int main() {
    std::cout << "========== SECTION 1: Material Values ==========\n\n";
    test_material_start_position();
    test_material_up_pawn();
    test_material_up_knight();
    test_material_up_bishop();
    test_material_up_rook();
    test_material_up_queen();
    test_material_piece_ordering();

    std::cout << "========== SECTION 2: PST Bonuses ==========\n\n";
    test_pst_pawn_advancement();
    test_pst_pawn_center_beats_wing();
    test_pst_knight_center_vs_rim();
    test_pst_bishop_active_vs_corner();
    test_pst_rook_rank_2_bonus();
    test_pst_queen_center_vs_rim();

    std::cout << "========== SECTION 3: Evaluator Properties ==========\n\n";
    test_property_perspective_negation();
    test_property_symmetry_all_pieces();
    test_property_score_bounded();
    test_property_equal_material_near_zero();

    std::cout << "========== SECTION 4: Terminal Detection ==========\n\n";
    test_terminal_checkmate();
    test_terminal_stalemate();
    test_terminal_non_terminal_returns_zero();

    std::cout << "\n========================================\n";
    std::cout << "ALL EVAL TESTS PASSED\n";
    return 0;
}
