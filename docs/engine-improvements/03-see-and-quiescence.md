# 03 — SEE (static exchange evaluation) and quiescence pruning

**Status:** not started
**Effort:** small–medium (~100–150 lines + tests)
**Elo:** roughly +50–100

## Summary

88% of all search nodes are spent in the quiescence search, because it tries
**every** capture — including obviously losing ones like a queen taking a pawn
that's defended by another pawn. Adding SEE lets the engine skip losing
captures there and order them last in the main search. The same time budget
then buys noticeably more depth.

## Background

### What quiescence search is for

The main search (`Search::negamax`) stops at a fixed depth. Evaluating the
position right there can be badly wrong: if a queen is hanging, or in the
middle of an exchange, the static score is nonsense ("the horizon effect").
So at depth 0 the engine switches to `Search::quiescence` (search.cpp ~636),
which:

1. takes the static eval as a "stand pat" score (the side to move can always
   decline to capture),
2. tries captures and promotions (all evasions if in check),
3. recurses until no capture improves the score.

That's correct and necessary. The problem is how many captures it tries.

### How captures are chosen and ordered today

- `quiescence` generates **all** pseudo-legal moves and filters to captures +
  promotions (search.cpp ~664–675). Nothing is skipped up front.
- Ordering is MVV-LVA (`getMvvLvaScore`, search.cpp ~88): most valuable victim
  first, least valuable attacker as a tiebreak. It knows *what* is captured but
  not *whether the capture loses material* to the recapture.
- The only pruning is **delta pruning** (~686–701): skip a capture if
  `standPat + victimValue + 200` still can't reach alpha. That removes captures
  that can't matter, but it happily searches QxP-defended-by-pawn whenever the
  side is near alpha.
- In the main search, `scoreMoves` (~733) puts **every** capture
  (`ORDER_CAPTURE_BASE = 1,000,000` + MVV-LVA) above killers and quiet moves.
  A losing capture like QxP(defended) is tried before a good quiet move.

## Evidence

From `bench depth 10` (1 thread) on 2026-10-28:

```text
Q-Search Load:    87.6% (Nodes spent in Q-search)
```

And on Kiwipete (`r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -`),
a **depth-1** search:

```text
info depth 1 seldepth 29 score cp 178 nodes 10842 ...
```

10,842 nodes and a selective depth of 29 plies to look **one** move ahead.
That's the capture tree exploding through every possible exchange sequence.

## What SEE is

Static exchange evaluation answers: "if both sides keep capturing on this one
square, always with their cheapest attacker, and either side may stop when
continuing would lose more, what's the material result of this capture?"

Example: `NxP` where the pawn is defended by a pawn: +100 (pawn) − 320
(knight recaptured) = **−220** → a losing capture. `PxN` defended by a queen:
+320 − 100 = **+220** → winning.

It's "static" because it only looks at one square — no other moves, no
checks, no pins. That makes it fast (a few dozen bit operations) and good
enough for pruning and ordering decisions.

## Design

### 1. `Board::attackersTo(square, occupancy)`

Returns a bitboard of all pieces of **both** colors attacking `square`, given
an occupancy mask. Built from the same tables `isSquareAttacked` already uses
(board.cpp ~519):

```cpp
uint64_t Board::attackersTo(int sq, uint64_t occ) const {
    return (ATTACK_TABLES.pawn_attacks[1][sq] & white_bitboards[PAWN])   // white pawns attacking sq
         | (ATTACK_TABLES.pawn_attacks[0][sq] & black_bitboards[PAWN])   // black pawns attacking sq
         | (ATTACK_TABLES.knight_attacks[sq] & (white_bitboards[KNIGHT] | black_bitboards[KNIGHT]))
         | (ATTACK_TABLES.king_attacks[sq]   & (white_bitboards[KING]   | black_bitboards[KING]))
         | (bishopAttacks(sq, occ) & (white_bitboards[BISHOP] | black_bitboards[BISHOP] |
                                      white_bitboards[QUEEN]  | black_bitboards[QUEEN]))
         | (rookAttacks(sq, occ)   & (white_bitboards[ROOK]   | black_bitboards[ROOK] |
                                      white_bitboards[QUEEN]  | black_bitboards[QUEEN]));
}
```

(Check the pawn-table color convention against `isSquareAttacked`, which uses
`pawn_attacks[attacker_color_index ^ 1][square]`.) The `occ` parameter is what
makes **x-rays** work: when a piece is "used up" in the exchange, remove it
from `occ` and recompute slider attacks — a rook behind a rook, or a queen
behind a bishop, then appears as the next attacker.

### 2. `see_ge(move, threshold)` — "does this capture win at least `threshold`?"

The threshold form (used by Stockfish and most modern engines) is simpler and
faster than computing the exact value, and it's what pruning needs:

```cpp
// True if the exchange started by `move` nets at least `threshold` for the
// side making it. Quiet moves can be tested too (threshold <= 0 checks the
// moved piece isn't simply lost).
bool Board::seeGE(const Move& m, int threshold) const {
    if (m.type == MoveType::CASTLE_KINGSIDE || m.type == MoveType::CASTLE_QUEENSIDE ||
        m.type == MoveType::PROMOTION || m.type == MoveType::EN_PASSANT)
        return 0 >= threshold;                       // keep it simple; treat as neutral

    const int from = m.start, to = m.end;
    int swap = pieceValue(mailbox_[to]) - threshold; // gain from the first capture
    if (swap < 0) return false;                      // even an uncontested capture isn't enough
    swap = pieceValue(mailbox_[from]) - swap;        // what we risk if they recapture
    if (swap <= 0) return true;                      // we win even if we lose the attacker

    uint64_t occ = (occupancy_[0] | occupancy_[1]) ^ (1ULL << from) ^ (1ULL << to);
    uint64_t attackers = attackersTo(to, occ);
    int stm = side_to_move == WHITE ? 0 : 1;         // side that just captured
    int result = 1;

    while (true) {
        stm ^= 1;
        attackers &= occ;
        uint64_t mine = attackers & occupancy_[stm];
        if (!mine) break;
        // (optional) pinned pieces can be excluded here
        result ^= 1;

        // Least valuable attacker; removing it may reveal an x-ray attacker.
        PieceIndex pt = leastValuable(mine, stm);    // PAWN..KING
        if (pt == KING) return (attackers & occupancy_[stm ^ 1]) ? result ^ 1 : result;
        if ((swap = pieceValue(pt) - swap) < result) break;
        occ ^= lowestBitOf(pieceBB(stm, pt) & mine);
        if (pt == PAWN || pt == BISHOP || pt == QUEEN) attackers |= bishopAttacks(to, occ) & diagonalSliders();
        if (pt == ROOK || pt == QUEEN)                 attackers |= rookAttacks(to, occ) & orthogonalSliders();
    }
    return result;
}
```

This is a sketch of the standard algorithm — when implementing, follow a
known-good reference (Stockfish `Position::see_ge`, or the Chess Programming
Wiki "SEE – The Swap Algorithm" page) line by line, then prove it with the
unit tests below. Piece values: use the search's `PIECE_VALUES`
(search.cpp ~65: 100/320/330/500/900) — not the tunable eval values, which
may drift after doc 04.

### 3. Use it in quiescence

In `Search::quiescence`, when **not in check**, skip captures that lose
material:

```cpp
if (!inCheck && move.isCapture() && !board.seeGE(move, 0)) continue;
```

Place it next to delta pruning. Keep searching all evasions when in check.
Promotions: leave them in (SEE above treats them as neutral).

### 4. Use it in move ordering (main search)

Split captures into good and bad in `scoreMoves`:

| Tier | Score |
| --- | --- |
| TT move | 2,000,000 |
| Good captures (SEE ≥ 0) | 1,000,000 + MVV-LVA |
| Promotions | 900,000 (+100 for queen) |
| Killers | 800,000 / 799,000 |
| Quiet moves | history (**must stay below killers — see doc 05**) |
| Bad captures (SEE < 0) | -1,000,000 + MVV-LVA |

SEE is only computed for captures, and only when they're scored — cheap.

### 5. (Later) SEE pruning in the main search

Once the above is proven, the usual next step: at low depth in non-PV nodes,
skip quiet moves with `!seeGE(move, -margin*depth)` and captures with
`!seeGE(move, -margin*depth*depth)`. That's a separate SPRT.

### 6. (Optional, speed) captures-only generator

`quiescence` builds the full pseudo-legal list and then filters it
(~668–674). A `generateCaptures()` that emits only captures and promotions
avoids generating ~30 quiet moves per qnode. Pure speed — bench node count
must stay identical.

## Tests

SEE unit tests in a new `tests/see_test.cpp` (or inside
`board_move_tests.cpp`). Use positions with a clear expected sign; verify each
by hand or with Stockfish before trusting it:

| FEN | Move | Expected |
| --- | --- | --- |
| `1k1r4/1pp4p/p7/4p3/8/P5P1/1PP4P/2K1R3 w - - 0 1` | `e1e5` (RxP, undefended) | wins a pawn: `seeGE(m, 0)` true, `seeGE(m, 100)` true, `seeGE(m, 101)` false |
| `1k1r3q/1ppn3p/p4b2/4p3/8/P2N2P1/1PP1R1BP/2K1Q3 w - - 0 1` | `d3e5` (NxP, defended several times) | loses material: `seeGE(m, 0)` false |
| a position with QxP defended by a pawn | QxP | `seeGE(m, 0)` false |
| PxN | PxN | `seeGE(m, 0)` true, `seeGE(m, 200)` true |
| a capture where an x-ray rook behind a rook decides the exchange | — | verifies the `occ` / x-ray logic |

(The first two are the classic examples from the Chess Programming Wiki SEE
page; exact values there use slightly different piece values, but the signs
hold.)

## Verification

1. `ctest -L tests` passes.
2. `bench depth 10`: **Q-Search Load should drop well below 87.6%** and total
   nodes for the same depth should drop. Record both.
3. Kiwipete depth-1 node count should fall far below 10,842.
4. `go movetime 400` from a middlegame position should reach a higher depth
   than ~12.
5. Tactical sanity suite (doc 01) solve count should not fall.
6. SPRT vs. `dev`: `elo0=0 elo1=10` at STC, then confirm at LTC.

Do steps 3 (qsearch) and 4 (ordering) as **two commits and two SPRT runs** if
the harness exists by then — it tells us which half carried the gain.

## Open questions

- Should promotions get proper SEE handling (value of promoted piece) rather
  than "neutral"? Probably not worth it initially.
- Exclude pinned attackers in SEE? Stockfish does; it's a refinement, not a
  first-pass requirement.
