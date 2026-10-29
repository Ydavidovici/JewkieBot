// Static exchange evaluation (Board::seeGE, doc 03).
//
// Each case gives the exchange's exact value with the search's piece values
// (P 100, N 320, B 330, R 500, Q 900), worked out by hand in the comment, and
// checks the threshold boundary on both sides: seeGE(v) true, seeGE(v + 1) false.

#include <cassert>
#include <iostream>
#include <string>

#include "board.h"
#include "move.h"

static Move find_move(const Board& b, const std::string& uci) {
    MoveList moves;
    b.generatePseudoMoves(moves);
    for (const auto& m : moves)
        if (m.toString() == uci) return m;
    std::cerr << "move not generated: " << uci << "\n";
    assert(false);
    return Move();
}

static int failures = 0;

static void expect_see(const char* label, const char* fen, const char* uci, int value) {
    Board b; b.loadFEN(fen);
    const Move m = find_move(b, uci);
    const bool at = b.seeGE(m, value);
    const bool above = b.seeGE(m, value + 1);
    const bool ok = at && !above;
    if (!ok) failures++;
    std::cout << "  " << (ok ? "ok  " : "FAIL") << " " << label << ": " << uci << " = " << value
              << "  (seeGE(" << value << ")=" << at << ", seeGE(" << value + 1 << ")=" << above << ")\n";
}

int main() {
    std::cout << "--- see_test ---\n";

    // Rxe5 takes an undefended pawn: +100.
    expect_see("undefended pawn", "1k1r4/1pp4p/p7/4p3/8/P5P1/1PP4P/2K1R3 w - - 0 1", "e1e5", 100);

    // Nxe5 into a crowd: +100 (pawn) -320 (Nd7xe5) = -220. White could go on
    // with Rxe5 (+320) but Bxe5 (-500) follows, so White stops at -220.
    expect_see("defended pawn, many attackers",
               "1k1r3q/1ppn3p/p4b2/4p3/8/P2N2P1/1PP1R1BP/2K1Q3 w - - 0 1", "d3e5", -220);

    // Qxe5, pawn defended by the d6 pawn: +100 -900 = -800.
    expect_see("queen takes pawn defended by pawn", "4k3/8/3p4/4p3/8/8/8/4QK2 w - - 0 1", "e1e5", -800);

    // exd5, knight defended by the queen: +320 -100 = +220.
    expect_see("pawn takes knight defended by queen", "3qk3/8/8/3n4/4P3/8/8/4K3 w - - 0 1", "e4d5", 220);

    // Rxd5 with a second rook behind it on d1. Black's Rd7xd5 would lose the
    // rook to Rd1xd5 (an x-ray: d1 only sees d5 once d2 has moved), so Black
    // doesn't recapture: +100. Missing the x-ray would give -400.
    expect_see("x-ray rook decides", "4k3/3r4/8/3p4/8/8/3R4/3RK3 w - - 0 1", "d2d5", 100);

    // Black, on a diagonal: Bxe4 (+100), dxe4 (-330), then the queen behind
    // on g6 takes back (+100): -130. Without the queen it would be -230.
    expect_see("black bishop takes, queen behind", "4k3/8/6q1/5b2/4P3/3P4/8/4K3 b - - 0 1", "f5e4", -130);
    expect_see("black bishop takes, nothing behind", "4k3/8/8/5b2/4P3/3P4/8/4K3 b - - 0 1", "f5e4", -230);

    // X-rays behind a *recapturing* piece (the cases above all have the hidden
    // slider behind the first mover, which the initial occupancy handles).
    // Nxe5 +100, Re7xe5 -320, Rxe5 +500, then Re8xe5 -500 (seen only once
    // Re7 has left): -220. Missing it would give +100.
    expect_see("x-ray behind a recapturing rook", "k3r3/4r3/8/4p3/8/5N2/8/4R1K1 w - - 0 1", "f3e5", -220);
    // Nxe5 +100, dxe5 -320, Rxe5 +100, then Bc7xe5 -500 (revealed when the d6
    // pawn recaptures): -220. Missing it would give -120.
    expect_see("x-ray behind a recapturing pawn", "k7/2b5/3p4/4p3/8/5N2/8/4R1K1 w - - 0 1", "f3e5", -220);

    // Black Qxe4, defended by the d3 pawn: +100 -900 = -800.
    expect_see("black queen takes pawn defended by pawn", "4k3/4q3/8/8/4P3/3P4/8/4K3 b - - 0 1", "e7e4", -800);

    // Quiet moves: Qc4 puts the queen where the d5 pawn takes it (-900);
    // Qc2 is safe (0).
    expect_see("quiet move into a pawn attack", "4k3/8/8/3p4/8/8/8/2Q1K3 w - - 0 1", "c1c4", -900);
    expect_see("quiet move to a safe square", "4k3/8/8/3p4/8/8/8/2Q1K3 w - - 0 1", "c1c2", 0);

    // Recapturing king: Rxd5 (+100), Kxd5 would win the rook (-500)... but
    // only if nothing else defends d5. Here the Rd1 behind covers it, so the
    // king can't recapture: +100.
    expect_see("king may not recapture into a defended square",
               "8/8/4k3/3p4/8/8/3R4/3RK3 w - - 0 1", "d2d5", 100);
    // Without the second rook the king recaptures: +100 -500 = -400.
    expect_see("king recaptures an undefended rook", "8/8/4k3/3p4/8/8/3R4/4K3 w - - 0 1", "d2d5", -400);

    if (failures) {
        std::cout << failures << " SEE CASE(S) FAILED\n";
        return 1;
    }
    std::cout << "ALL SEE TESTS PASSED\n";
    return 0;
}
