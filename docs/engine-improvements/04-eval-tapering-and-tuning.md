# 04 — Evaluation: tapering and proper Texel tuning

**Status:** not started
**Effort:** medium (eval restructure + tuner rewrite + dataset)
**Elo:** roughly +100–200 — likely the largest single gain before NNUE

## Summary

The evaluation's numbers are hand-written and out of proportion (a pawn
reaching e4 is worth more than half a pawn), and almost none of them change
between middlegame and endgame. The engine already has a Texel tuner, but it
learns from limited data with a fixed scaling constant and a slow optimizer.
Restructuring the eval into middlegame/endgame pairs and tuning it properly on
a standard dataset is the biggest strength gain available short of a neural
network.

## Background

### What the evaluator computes

`Evaluator::evaluate` (evaluator.cpp ~55) returns a score in centipawns from
the side to move's point of view. It sums, White minus Black:

1. **Material + piece-square tables (PSTs)** for pawn…queen, pre-combined into
   `combinedTables[color][piece][square]` (~60–74). Material values:
   P 100, N 320, B 330, R 500, Q 900 (`evaluator.h` ~70).
2. **King PST, tapered** between `whiteKingTableMG` and `whiteKingTableEG` by
   game phase (~76–109). Phase: N=1, B=1, R=2, Q=4, 24 = full board.
3. **Pawn structure** (`pawnStructureScore`, ~126): doubled −12, isolated −10,
   passed pawn bonus by relative rank `{0,10,15,25,40,65,100,0}`.
4. **Piece activity** (`pieceActivityScore`, ~162): bishop pair +30, mobility
   per reachable square (N 4, B 3, R 2, Q 1), rook on open file +20 /
   semi-open +10.
5. **King shelter** (`kingShelterScore`, ~216): pawn directly in front +10,
   two ahead +5, no pawn on an adjacent file −15; scaled by phase (~119).

### What "tapered" means

Many things are worth different amounts in the middlegame and the endgame:

- the king should hide in the middlegame and centralize in the endgame;
- passed pawns are modest in the middlegame and decisive in the endgame;
- knights lose value as pawns come off, rooks gain;
- mobility and king safety matter far more with queens on.

A tapered eval keeps **two values for every term** (MG and EG) and blends
them by phase: `score = (mg * phase + eg * (24 - phase)) / 24`. Here, only the
king PST does that. Everything else uses a single number all game.

### What Texel tuning is

Instead of guessing weights, take a large set of positions whose game outcome
is known (1, ½, 0). Convert the eval to a predicted win probability with a
sigmoid, `P = 1 / (1 + 10^(-K·eval/400))`, and adjust all weights to minimize
the mean squared error between predicted and actual results. The eval learns
whatever predicts results best.

The engine already implements this: `Evaluator::tuneFromDataset`
(evaluator.cpp ~488), exposed as the UCI `tune <dataset.epd> <output> [epochs]`
command, driven remotely by `backend/src/controllers/tuningController.ts`.
Results are written to `eval_params.txt`, which the backend loads at engine
start if the file exists (`engineManager.ts` ~107, `EvalParamsFile` option).

## Evidence

### The numbers are out of proportion

White pawn table (evaluator.cpp ~300, square 0 = a1, first row = rank 1):

```text
rank 2:   5, 10, 10, -20, -20, 10, 10,  5
rank 4:   0,  0, 10,  40,  40, 10,  0,  0
rank 5:   5,  5, 20,  60,  60, 20,  5,  5
rank 6:  10, 10, 30,  80,  80, 30, 10, 10
rank 7:  50, 50, 50,  50,  50, 50, 50, 50
```

`e2→e4` is worth +60 from the table alone; a pawn on d6 is +80 *before* the
passed-pawn bonus stacks on top. For comparison, a centralized knight earns
+20.

Static evals (`eval` command; the engine prints from the side to move, so a
negative number with Black to move is good for White):

| Position | Engine | Typical engine |
| --- | --- | --- |
| after `1.e4` | **+73** for White | +20 to +35 |
| main-line Najdorf after `…a6` | **+128** for White | ~+30 |
| Ruy Lopez after `3…a6` | +5 | ~+30 |
| `1.d4 d5 2.c4` | −3 for Black to move ≈ +3 White | ~+30 |

The swings are driven by pawn placement, which pushes the engine toward pawn
moves and overextension. The old note in `engines/jewkiebot/jewkiebot.txt` —
"the engine really only makes pawn moves or captures" — fits.

### Only the king is tapered

Passed-pawn bonuses, mobility, the bishop pair, and every PST are single
values used from move 1 to the end. King shelter fades with phase, but in a
fixed proportion rather than tuned MG/EG values.

### Weak endgame knowledge (overlaps doc 06)

King + knight vs. king evaluates around +300 (material), though it's a dead
draw. King + pawn vs. king: +80.

### The tuner's limitations

From `evaluator.cpp` (~481–559) and `tuningController.ts`:

| Limitation | Effect |
| --- | --- |
| **Dataset = games already in the DB** (`_buildEpd`: drops the first 12 plies and in-check positions, labels 1/½/0 from the game result) | Small, and dominated by whatever games happen to be stored (the bot's own games, chess.com imports). Biased toward its own style and mistakes |
| **No quiet-position filter** | Many positions are mid-exchange (a piece just captured, recapture pending). Their static eval is meaningless, which teaches the tuner noise |
| **Fixed `K` (scale 400)** | The sigmoid's steepness should be *fitted* to the dataset first; with the wrong K the tuner warps all weights to compensate |
| **±1 coordinate descent**: for each of 410 parameters, try +1 and −1, re-evaluating the whole dataset each time | ~820 full passes per epoch. Very slow, and it can only creep one centipawn at a time |
| **Only 410 parameters**, single-phase (MG king table included, EG king table not) | Even perfect tuning can't express "worth more in the endgame" |
| **Output layout is positional** (`getParameter` index order); `loadParametersFromFile` applies whatever prefix it reads | If the layout changes, an old `eval_params.txt` silently loads garbage into the wrong slots |

That last row matters for this doc: **restructuring the eval invalidates any
existing `eval_params.txt`**, including one that might already be on the
server (`engines/jewkiebot/eval_params.txt` is git-ignored; the backend loads
it if present).

## Design

### Step 1 — Restructure the eval into MG/EG pairs

Represent every term as a pair. A common trick packs both into one `int`
(`S(mg, eg) = (int)((unsigned)eg << 16) + mg`), so adding scores adds both
halves at once; or just keep two accumulators. Then:

```cpp
int mg = 0, eg = 0;
// ... every term adds to both ...
int phase = computePhase(board);               // 0..24, existing formula
int score = (mg * phase + eg * (24 - phase)) / 24;
```

Parameters after the change (sizes approximate):

| Term | Now | After |
| --- | --- | --- |
| Material (P, N, B, R, Q) | 5 | 5 × 2 |
| PSTs (P, N, B, R, Q, K) | 6 × 64, king MG+EG | 6 × 64 × 2 |
| Passed pawn by rank | 8 | 8 × 2 |
| Doubled / isolated pawn | 2 | 2 × 2 |
| Mobility | 4 linear weights | per piece × per square-count (N: 9, B: 14, R: 15, Q: 28), × 2 — or keep linear × 2 first |
| Bishop pair, rook open/semi-open | 3 | 3 × 2 |
| King shelter terms | 3 | MG only (or × 2) |
| Tempo (side to move bonus) | — | 1 (new, ~+10–20 MG) |

Keep `evaluate()`'s external contract the same (side-to-move centipawns) so
search code is untouched.

Phase it in two commits so each can be checked:
1. **Pure restructure**: duplicate today's values into both MG and EG
   (king keeps its two tables). Eval output must be **identical** → bench node
   count unchanged. This proves the plumbing.
2. **Tune** (step 3) and replace the defaults with the tuned values.

### Step 2 — A versioned params file

- First line: `# jewkiebot-eval v2 <param-count>`.
- `loadParametersFromFile` refuses a file with a missing or mismatched header
  (prints `info string eval params version mismatch, using defaults`).
- Bake the tuned values into the source as the compiled defaults once they
  pass SPRT, so the engine is strong even without the file. The file then
  only matters for experiments.

### Step 3 — Rewrite the tuner

Use the standard "linear Texel" approach (see Andrew Grant's paper
*Evaluation & Tuning in Chess Engines*, written for Ethereal):

1. **Precompute coefficients.** For each position, record how many times each
   parameter contributes, split into MG and EG parts (e.g. "2 white knights on
   these squares, 1 black passed pawn on rank 5 …") plus the phase. Then
   `eval = Σ (coeff_mg[i]·mg[i]·phase + coeff_eg[i]·eg[i]·(24−phase)) / 24`
   is linear in the parameters, and its gradient is exact and cheap.
2. **Fit K first**: with the current parameters, line-search the K that
   minimizes MSE. Keep K fixed while tuning weights.
3. **Gradient descent** (Adam or plain GD with momentum) over all parameters
   at once, many epochs, until MSE stops improving.
4. **Hold out 10%** of positions; report validation MSE so we notice
   overfitting.

This moves from "820 dataset passes per epoch, one centipawn at a time" to
"one pass per epoch, all parameters at once", typically minutes on hundreds of
thousands of positions.

Where it runs: it can stay inside the engine binary (the `tune` UCI command,
so the eval code is shared and can't drift), or be a separate `tuner` target
in `CMakeLists.txt` linking the evaluator. A separate target is easier to
iterate on.

### Step 4 — A proper dataset

Options, in order of preference:

1. **A standard quiet-labeled dataset.** The best-known is zurichess's
   "quiet-labeled" EPD (~725k positions, each already quiet, labeled with the
   game result; widely used for exactly this). Format is
   `<fen> c9 "1-0";` — close to what the current loader expects (it reads the
   text between the quotes after `c9 "`), but verify the trailing `;` parses.
   Larger public sets exist (e.g. "lichess-big3-resolved", several million
   positions).
2. **Self-generated:** play a few thousand fast self-play games (doc 01's
   harness), sample positions, keep only quiet ones (not in check, and
   quiescence score == static eval), label with the result. Slower to get
   started; tailored to this engine.
3. **DB games (current approach):** keep as a supplement at most.

Quiet filter, whichever source: drop positions in check, and drop positions
where `quiescence(pos) != evaluate(pos)` — that means a capture changes the
score, so the static eval isn't trustworthy there.

The datasets are large — keep them out of git (under `tools/`, which is
already ignored for `*.epd`).

### Step 5 — Backend

`tuningController.ts` builds its own dataset from DB games and runs `tune`
remotely. After this doc either:
- point it at the standard dataset (plus optional DB games), or
- retire it and tune locally, committing the resulting defaults.

The second is simpler and reproducible.

## Verification

1. **Restructure commit:** eval output identical on a set of FENs; bench node
   count unchanged.
2. **Tuner:** MSE on training and validation sets decreases and flattens; K
   reported.
3. **Sanity positions after tuning** (expect, not require):
   - `1.e4`: +20 to +45 for White
   - main-line Najdorf: −10 to +50
   - K+N vs K stays material-only here (doc 06 fixes draws) — just note it
   - a clearly winning position (e.g. up a rook) remains ≥ +400
4. **SPRT** tuned vs. `dev`: `elo0=0 elo1=10` STC, then LTC.

## Open questions

- Packed `S(mg, eg)` ints or two accumulators? Packed is faster and standard;
  two accumulators are easier to read. Either is fine.
- Mobility: linear weights (simple) or per-count tables (more expressive, many
  more parameters)? Start linear MG/EG, try tables later.
- Do we keep the remote tuning dashboard?
- Is there an `eval_params.txt` on the server right now? If yes, it was tuned
  against today's layout and will need regenerating (the version header from
  step 2 makes a stale file harmless).
