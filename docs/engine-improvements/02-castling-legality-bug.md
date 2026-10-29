# 02 — Castling legality bug in search

**Status:** fixed 2026-10-29 (Option A). SPRT passed: **+9.0 ± 6.0 Elo** over 8,050 games. See "Result" at the end
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

> **Correction (2026-10-29):** the position below is wrong. White's h1 rook
> sees up the open h-file, so Black starts **in check** and `Ra1` isn't even
> legal (Stockfish: only `Kg8`/`Kg7`). The engine's `h8g7` was correct there.
> The working reproduction adds a pawn on h2 to close the file:
> `r6k/8/8/8/8/8/3PPP1P/4K2R b K - 0 1` — Stockfish: `score mate 1 pv a8a1`.
> Before the fix the engine also played `a8a1` there, but only as a good move
> (`score cp -425 pv a8a1 e1g1 …`, castling out of check); after it,
> `score mate 1` from depth 1. The bug itself was real, as perft showed.

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

## Result (2026-10-29)

Option A in `Board::generatePseudoMoves()`. The castling check in
`generateLegalMoves()` was removed, so there's one source of truth.

| Check | Before | After |
| --- | --- | --- |
| Perft (`test_perft`) | 8/15 (Kiwipete d4 +25,553) | **15/15** |
| Mate-in-1 with a castling right (corrected FEN above) | `a8a1` as `cp -425`, PV castles out of check | `score mate 1` at depth 1 |
| Bench | 17,250,320 | **16,371,041** (fewer, correct moves to search) |
| Tactics, Lichess file | 190–196/200 | 190–196/200 (no measurable change; puzzles rarely hinge on castling) |
| Tactics, regressions | 0/1 | 1/1 |
| SPRT vs. pre-fix `dev` (8+0.08, gainer 0/5) | | **H1 accepted: +9.0 ± 6.0 Elo**, 8,050 games (W 2924, L 2715, D 2411), LLR 2.97 |

Tests added. Each one was checked to **fail on the old `board.cpp`**:
- `test_pseudo_castling_respects_attacks` (board_move_tests): 9 Stockfish-verified
  positions, both colors and both sides, plus a landing-square case.
- `test_coverage_mate_in_1_castling_right` (search_test): asserts the move
  *and* that the search reports `score mate 1`, because the old code found the move too.

Found on the way: **no `assert()` in the test suites ever ran.** Release
and RelWithDebInfo define `NDEBUG`, so every check was a no-op. CMake now builds
the tests with `-UNDEBUG`, and all existing assertions pass. One test that could
never fail before, `time_manager_test`, is sleep-based with narrow windows
(e.g. "sleep 140 ms, expect between 100 and 200"). It failed once in about 6 runs on
Windows timer jitter and needs looser timing or a fake clock (follow-up).

The SPRT took about 7.5 hours. The early lead (+29 after 676 games) was
partly luck, and the estimate settled at about +9. That's below the doc's
+20–60 guess: Lichess-style games rarely reach the positions where an
illegal castle in the search tree changes the move played. Watching the
old base engine, fastchess warned 550+ times about illegal castles in its
PV output; the fixed engine had none.

The match had 60 losses on time (0.7%), all small overruns (1–95 ms), split
between the two sides. That doesn't bias the result, but an engine with a
100 ms move-overhead margin shouldn't overrun at all. It's worth a look
alongside the flaky `time_manager_test`, since the bot plays bullet.
