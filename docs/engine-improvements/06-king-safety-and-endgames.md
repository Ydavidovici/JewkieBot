# 06 — King safety and endgame knowledge

**Status:** not started
**Effort:** medium
**Elo:** roughly +30–60
**Depends on:** doc 04 (tapered eval + tuner) — new terms should be tuned, not hand-set

## Summary

Two gaps in the evaluation:

1. **King safety** is only pawn shelter. The engine doesn't count enemy pieces
   aiming at its king, so it walks into attacks until the search happens to
   see the mate.
2. **Endgame knowledge** is missing: no draw recognition, no scaling. King +
   knight vs. king scores ~+300 although nobody can win it.

## Part A — King safety

### What exists

`Evaluator::kingShelterScore` (evaluator.cpp ~216): for the king's file and
the two adjacent files, +10 for an own pawn one rank ahead, +5 for two ranks
ahead, −15 for a file with no own pawn at all. Scaled by game phase (~119).
That's all.

### What's missing

The single most important king-safety signal in hand-written evals is **how
many enemy pieces attack the squares around the king, and with what**. A
king behind three pawns with a queen, rook and knight all aimed at it is in
grave danger; the current eval sees a perfectly sheltered king.

### Design: attack units

Standard approach (Stockfish's classic eval, Ethereal, many others):

1. **King zone** = the king's square + its 8 neighbours (+ optionally the
   row of squares 2 ranks in front of it).
2. While computing mobility in `pieceActivityScore` (which already has each
   piece's attack bitboard), for every enemy piece whose attacks touch the
   zone, add:
   - `attackerCount += 1`
   - `attackWeight += weight[pieceType]` (e.g. N 20, B 20, R 40, Q 80 — tune)
   - optionally, `+ k * popcount(attacks & zone)` per piece
3. Add extra units for:
   - **safe checks** available to the enemy (a square from which a piece
     could give check and isn't defended),
   - the own **king's open files** (already partly in shelter),
   - **weak squares** in the zone (attacked by the enemy, defended only by our
     king or queen).
4. Convert units to a penalty through a **non-linear** curve — one attacker is
   harmless, three or four is lethal. Either a lookup table
   (`SafetyTable[units]`, classic) or a quadratic like
   `penalty = units * units / 720` (Stockfish-style). Apply only if
   `attackerCount >= 2` and the attacker has a queen (common gating).
5. **Middlegame only** (EG weight 0) — it fades with phase automatically
   under doc 04's tapering.

Also worth adding later: **pawn storm** — enemy pawns advancing on files
around our king (bonus to the attacker by rank and blockage).

### Tuning

These weights are notoriously hard to hand-set. Implement the structure with
reasonable starting values, then let the doc 04 tuner fit them (the linear
tuner can handle a quadratic term if the units are treated as a feature; or
tune just the safety table with SPSA through the SPRT harness).

## Part B — Endgame knowledge

### What exists

`Board::isInsufficientMaterial()` (board.cpp ~892) recognizes K vs K, a
single minor vs bare king, and KB vs KB on same-colored squares. **But it's
only used by `Engine::isGameOver()`** (engine.cpp) — neither the search nor
the evaluator calls it. So inside the search those positions score as
material.

### Design

1. **Draw recognition in search.** In `negamax` (next to the
   repetition/fifty-move check, search.cpp ~440), return 0 for
   insufficient-material positions. Cheap: it's a few popcounts.
2. **Draw-ish material in eval** (scale factors). Compute a scale factor
   0–128 applied to the endgame part of the score (128 = normal):
   - **No pawns and the stronger side has less than a rook's worth extra**
     (KN vs K, KB vs K, KNN vs K, KR vs KB, KR vs KN, KB vs KN …): scale to
     near 0 (KNN vs K) or small (KR vs KB ≈ 16/128).
   - **Opposite-colored bishops** with otherwise only pawns: scale ~64/128
     (more if pawn counts differ a lot).
   - **One side has no pawns**: the side without pawns can't win if it isn't
     up by more than a minor — scale its advantage down.
   - Rook endgames with all pawns on one side and pawn difference ≤ 1: scale
     down modestly.
3. **Mop-up** for clearly won pawnless endings (KQ vs K, KR vs K, KBN vs K):
   bonus for pushing the losing king to the edge/corner and bringing the
   winning king close. Without it the engine can shuffle instead of mating
   (within the search horizon it finds the mate; outside it may not).
4. **Fifty-move scaling (optional):** scale the score toward 0 as
   `halfmove_clock` approaches 100, so the engine prefers progress over
   shuffling in won positions. Needs `Board` to expose the halfmove clock
   (it has the field; add a getter).

### Endgame tablebases (later, optional)

Syzygy tablebases give perfect play with ≤ 5–7 pieces. Probing code (Fathom)
is a self-contained C library. The 5-piece set is ~1 GB. This is a real gain
in endgames but needs the files on the server; consider after docs 01–05.

## Tests

`tests/eval_test.cpp` additions (assert sign/range, not exact values, since
tuning will move them):

| Position | Expectation |
| --- | --- |
| K+N vs K | `|eval| <= 20` |
| K+B vs K | `|eval| <= 20` |
| K+N+N vs K | `|eval| <= 50` |
| K+R vs K+B, no pawns | well under a rook (e.g. `< 200`) |
| Opposite-colored bishops, White one pawn up | noticeably less than the same position with same-colored bishops |
| K+Q vs K | `> 900`, and higher when the black king is on the edge than in the centre (mop-up) |
| Castled king with Q+R+N aimed at it vs. same king unattacked | first is clearly worse for the defender |

Search test: from K+Q vs K, `go depth 12` finds a mate score.

## Verification

- `ctest -L tests` passes.
- SPRT: king safety and endgame scaling as **separate** runs (`elo0=0 elo1=5`).
  King safety gains tend to show more at LTC.

## Open questions

- Include the "safe checks" term in the first version, or start with zone
  attacks only? (Start simple.)
- Tablebases: is the ~1 GB of 5-piece Syzygy files OK on the server?
