# 02 — Castling legality bug in search

**Status:** bug confirmed 2026-10-28, not fixed
**Effort:** ~10–20 lines + tests
**Elo:** roughly +20–60 (it's a correctness bug; the exact gain depends on how often it bites)

## Summary

During search the engine lets a side castle **out of check** and **through an
attacked square**. It never *plays* an illegal castle at the root, but inside
the tree it evaluates lines where the opponent escapes with one. The visible
symptom: it misses mates and misjudges attacks against an uncastled king.

## Background: how legality works in this engine

There are two move generators in `src/board.cpp`:

| Function | Used by | How legality is decided |
| --- | --- | --- |
| `generateLegalMoves()` (line ~540) | root move list (`Search::findBestMove`), `applyMove` for UCI `position … moves` | Generates pseudo-legal moves, then for each: special-cases castling (king not in check, passing square not attacked), then make/unmake to test the king isn't left in check |
| `generatePseudoMoves()` (line ~373) | **everything inside the search**: `negamax` (search.cpp ~518), `quiescence` (~666, ~669) | Generates moves by piece-movement rules only. Legality is decided later by `makeMove()` |

`makeMove()` (line ~580) applies the move and then, at the end (lines
~749–753), rejects it if the moving side's king is attacked **on its final
square**:

```cpp
if (pieceBB(us_color, KING) &&
    isSquareAttacked(findKing(us_color), opponent_color)) {
    unmakeMove();
    return false;
}
```

That's sufficient for every move type **except castling**, which has two extra
rules: the king may not castle while in check, and may not pass through an
attacked square. Those checks exist only in `generateLegalMoves()`
(lines ~564–571):

```cpp
if (move.type == MoveType::CASTLE_KINGSIDE || move.type == MoveType::CASTLE_QUEENSIDE) {
    ...
    if (isSquareAttacked(king_start_square, opponent_color)) continue;
    if (isSquareAttacked(king_middle_square, opponent_color)) continue;
}
```

And `generatePseudoMoves()` emits castling whenever the rights are present and
the squares between king and rook are empty (lines ~484–494) — no attack
checks:

```cpp
if (us_color == Color::WHITE) {
    if ((castling_rights & 0b0001) && !(all_occupancy & ((1ULL << 5) | (1ULL << 6))))
        out.push_back(Move(4, 6, MoveType::CASTLE_KINGSIDE));
    ...
```

So in the search path, `makeMove` only verifies the king's landing square (g1
/ c1 / g8 / c8). Castling out of check, or through f1/d1/f8/d8 while attacked,
is accepted.

A subtle extra: when the king castles out of a rank attack, the rook lands
between the attacker and the king (e.g. rook a1 checking along the first rank,
White castles short, rook h1→f1 blocks), so even the landing-square check
passes.

## Reproduction

Position (Black to move): `r6k/8/8/8/8/8/3PPP2/4K2R b K - 0 1`

`Ra1#` is mate in one: the rook checks along the first rank; d1 is attacked;
f1 is attacked once the king leaves e1; d2/e2/f2 are own pawns; nothing can
block or capture; castling is illegal because White is in check.

```text
position fen r6k/8/8/8/8/8/3PPP2/4K2R b K - 0 1
go depth 6
info depth 1 seldepth 1 score cp -298 pv h8g7
info depth 3 seldepth 6 score cp -337 pv h8g7 d2d4 g7f6
info depth 6 seldepth 9 score cp -370 pv h8g8 d2d4 a8a4 e2e3 a4a1 e1g1
bestmove h8g8
```

The engine plays `Kg8` and thinks it's losing. Its own PV ends with
`a4a1 e1g1` — castling out of check.

Control: same position **without** White's castling right:

```text
position fen r6k/8/8/8/8/8/3PPP2/4K2R b - - 0 1   (note: no K)
```

(the run on 2026-10-28 used `r6k/8/8/8/8/8/3PPP2/4K3 b - - 0 1`, also without
the rook)

```text
info depth 1 seldepth 0 score mate 1 pv a8a1
bestmove a8a1
```

Found instantly.

## Why it matters in real games

- In most middlegames at least one side still has a castling right.
- The bug only fires in lines involving checks or attacks near an uncastled
  king — exactly the sharp positions where accuracy decides games.
- It also corrupts the PV shown to users (illegal castles in `info … pv`), and
  any downstream analysis built on it (the backend's analysis/explorer pages
  read the engine's PV).

## Fix

### Option A (recommended): check attacks when generating castling

In `generatePseudoMoves()`, only emit a castling move when the king is not in
check and the square it passes over is not attacked. The landing square stays
checked by `makeMove()` as for every other move.

```cpp
// Castling: the king may not castle out of check or through an attacked
// square. The landing square is checked by makeMove() like any other move.
const Color them = (us_color == Color::WHITE ? Color::BLACK : Color::WHITE);
const int king_from = (us_color == Color::WHITE ? 4 : 60);
const uint8_t short_right = (us_color == Color::WHITE ? 0b0001 : 0b0100);
const uint8_t long_right  = (us_color == Color::WHITE ? 0b0010 : 0b1000);

if (castling_rights & (short_right | long_right)) {
    const bool in_check = isSquareAttacked(king_from, them);
    if (!in_check) {
        if ((castling_rights & short_right) &&
            !(all_occupancy & ((1ULL << (king_from + 1)) | (1ULL << (king_from + 2)))) &&
            !isSquareAttacked(king_from + 1, them))
            out.push_back(Move(king_from, king_from + 2, MoveType::CASTLE_KINGSIDE));

        if ((castling_rights & long_right) &&
            !(all_occupancy & ((1ULL << (king_from - 1)) | (1ULL << (king_from - 2)) | (1ULL << (king_from - 3)))) &&
            !isSquareAttacked(king_from - 1, them))
            out.push_back(Move(king_from, king_from - 2, MoveType::CASTLE_QUEENSIDE));
    }
}
```

Notes:

- Queenside: b1/b8 must be **empty** but may be attacked (only the king's path
  e→d→c matters). The existing emptiness mask is already right; keep it.
- `isSquareAttacked` is a private member and `generatePseudoMoves` is a member,
  so no visibility changes are needed. `generatePseudoMoves` is `const`;
  `isSquareAttacked` is `const` too.
- Cost: at most three attack lookups, and only when a castling right exists and
  the path is empty. Negligible.
- After this, the castling special case in `generateLegalMoves()` becomes
  redundant. Either delete it (one source of truth) or leave it as a
  belt-and-braces check; deleting is cleaner.

### Option B: reject in `makeMove()`

Add the in-check / passing-square test at the top of `makeMove()` for castling
moves and return `false`. Works, but it's wasted effort — the move is
generated, scored, sorted, and only then rejected. Option A is better.

## Tests to add

1. **`tests/board_move_tests.cpp`** — a new `test_pseudo_castling_respects_attacks()`
   that calls `generatePseudoMoves()` (not the legal generator) and asserts:
   - no castling in `r6k/8/8/8/8/8/3PPP2/R3K2R w KQ - 0 1` after Black plays
     a checking move (or set up a direct in-check FEN, e.g.
     `4k3/8/8/8/8/8/8/R3K2r w Q - 0 1` with the h1 rook giving check);
   - no short castle when f1 is attacked, e.g. `4k3/8/8/2b5/8/8/8/4K2R w K - 0 1`
     (bishop c5 hits f2… pick a FEN where a bishop or rook covers f1 exactly;
     verify with Stockfish/lichess board editor before committing);
   - long castling *still allowed* when only b1 is attacked.
2. **Search regression** in `tests/search_test.cpp`: the mate-in-1 above must
   return `a8a1` with a mate score.
3. **Perft through the search path** (doc 01): Kiwipete and Position 4 counts
   must match the reference values.
4. Add the mate-in-1 to the tactical sanity suite (doc 01, layer 3).

## Verification

- `ctest -L tests` passes, including the new cases.
- The reproduction prints `score mate 1 pv a8a1`.
- Bench node count changes (expected — search now sees fewer, correct moves).
  Record the new number.
- Optional but recommended: SPRT vs. current `dev` with `elo0=0 elo1=10`.
  A correctness fix like this is usually merged regardless of the result, but
  the number tells us how often it mattered.

## Related nits to fix in the same area (separate commits)

- `Board::isRepetitionDraw()` walks back through `move_history` two plies at a
  time and crosses null moves (`makeNullMove` pushes an entry with
  `moved_piece = PieceTypeCount`). A "repetition" that includes a null move
  isn't a real repetition. Stop the scan at a null-move entry.
- `Board::generateLegalMoves()` has a branch for "no king on the board"
  (returns all pseudo moves). Fine for test positions; leave it.
