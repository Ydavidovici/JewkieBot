# Engine improvement plan

Working notes from the 2026-10-28 deep dive into what limits jewkiebot's playing
strength. Each numbered file is a self-contained design doc for one piece of
work: background, the evidence we found, a proposed design, how to verify it,
and open questions. Work through them one at a time, on `dev`.

Engine source lives in `engines/jewkiebot/` (C++20, CMake). Line references in
these docs are to the code as of commit `dd0addd` (2026-10-28) — re-check them
before editing, they drift.

## How the engine is put together

| Part | Files | Job |
| --- | --- | --- |
| Board | `src/board.cpp`, `include/board.h` | Bitboard position, move generation, make/unmake, draw detection, Zobrist hashing |
| Search | `src/search.cpp`, `include/search.h` | Iterative deepening, alpha-beta (negamax, PVS), pruning/reductions, quiescence, move ordering, lazy SMP |
| Evaluation | `src/evaluator.cpp`, `include/evaluator.h` | Static score: material, piece-square tables, pawn structure, mobility, king shelter; Texel tuner |
| Transposition table | `src/transpositionTable.cpp` | Lockless hash of searched positions |
| Time manager | `src/timeManager.cpp` | Soft/hard deadlines per move |
| UCI / glue | `src/main.cpp`, `src/engine.cpp` | Protocol, options (Hash, Threads, BookFile, EvalParamsFile), `bench`, `tune` |
| Backend driver | `backend/src/engineManager.ts`, `backend/src/lichessBot.ts` | Spawns engines, sends `position startpos moves …` + `go wtime …` |

Search decides **how far** the engine sees; evaluation decides **how well it
judges** what it sees at the end of each line. Both cap strength.

## Bench baseline (2026-10-29, the reference for every change)

`bench` (doc 01, layer 2) is deterministic: 32 positions, depth 11, one thread,
TT cleared per position. The node count is the fingerprint — a pure refactor or
speed-up must keep it; anything that changes it records the new number.

| Metric | Value |
| --- | --- |
| **Bench** | **17,250,320 nodes** (~15 s, ~1.39M nps on the dev laptop). After doc 02: **16,371,041** |
| Eval throughput | ~3.0M evals/s (`bench nosearch`) |
| Move ordering | 83.8% first-move cutoffs |
| Quiescence share | 67.3% of nodes |
| TT hit rate | 21.4% of probes |
| Perft (`test_perft`) | 15/15 since doc 02. Before it: 8/15 pass; the 7 failures are the castling bug (doc 02). Kiwipete d4: 4,111,156 vs correct 4,085,603 (+25,553). Every root move is off by 58–3,572; the worst four are the knight moves to c6/d7/f7/g6, which attack the squares Black's king castles through |
| Perft speed | ~14M nodes/s (start position d6: 119,060,324 nodes, correct, in 8.6 s). Baseline for doc 08 |
| Tactics (`scripts/tactics.ts`) | Lichess file: 190–196/200 at 500 ms over 5 runs (same code; time-limited search varies run to run), 189–190/200 at 100 ms. Misses are mostly pins, deflections, quiet and defensive moves. Regression file: 1/1 since doc 02 |

Run with `scripts/run.sh`, then `bench` (or `printf 'bench\nquit\n' | build/jewkiebot.exe`).

## Earlier measurements (2026-10-28)

Taken with the 2026-10-17 build and the old 3-position bench (not
deterministic; superseded by the table above), 1 thread, on the dev laptop
(16 logical cores).

| Metric | Value | How to reproduce |
| --- | --- | --- |
| Speed | ~0.9M nodes/s | `setoption name Threads value 1` then `bench depth 10` |
| Eval throughput | ~780k evals/s | `bench nosearch eval 3000` |
| Move ordering | 89–93% first-move cutoffs | `bench depth 10` → "Move Ordering" |
| Quiescence share | **87.6%** of nodes | `bench depth 10` → "Q-Search Load" |
| TT hit rate (reported) | 1.8% | `bench depth 10` → misleading, see doc 05 |
| Depth reached in 400 ms | ~12 (seldepth 25+) | `go movetime 400` from a Ruy Lopez position |
| Warm-TT re-search | 178k → 36k nodes (5x) on a quiet middlegame | search the same FEN twice at depth 9 |
| Static eval after `1.e4` | +73 for White | `position startpos moves e2e4` then `eval` (prints from Black's side: -73) |
| Static eval, main-line Najdorf | +128 for White | `position startpos moves e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6` then `eval` |

## Priority order

Elo figures are rough expectations from typical engine development, **not
measurements**. Only an SPRT match (doc 01) turns them into facts.

| # | Doc | Work | Effort | Rough Elo | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | [Testing harness](#testing-harness) | Perft, bench, tactics, SPRT | Small–medium | (enabler) | **Done** 2026-10-29 |
| 2 | [02-castling-legality-bug.md](02-castling-legality-bug.md) | Search castles out of / through check | ~10 lines | +20–60 (measured: **+9 ± 6**) | **Done** 2026-10-29, SPRT passed |
| 3 | [03-see-and-quiescence.md](03-see-and-quiescence.md) | Static exchange evaluation; prune losing captures | Small–medium | +50–100 | Not started |
| 4 | [04-eval-tapering-and-tuning.md](04-eval-tapering-and-tuning.md) | MG/EG tapered eval, real Texel tuning | Medium | +100–200 | Not started |
| 5 | [05-search-heuristics.md](05-search-heuristics.md) | History, countermoves, TT aging, IIR, … | Medium (many small) | +50–100 total | Not started |
| 6 | [06-king-safety-and-endgames.md](06-king-safety-and-endgames.md) | King attack eval, draw scaling | Medium | +30–60 | Not started |
| 7 | [07-production-config.md](07-production-config.md) | Threads per engine, pondering | Tiny / medium | Unknown, possibly large | Not started |
| 8 | [08-speed.md](08-speed.md) | Magic bitboards, incremental eval | Medium | +10–30 | Not started |
| 9 | [09-nnue.md](09-nnue.md) | Neural-network evaluation | Large | +200–400 (long term) | Not started |

Suggested sequence: **02 → 03 → 01 → 04 → 05 (one heuristic at a time) → 06/07
→ 08 → 09.** Docs 02 and 03 come before the harness because they're small,
obviously-correct fixes with their own direct checks (a mate-in-1 position and
the quiescence share); everything after that should be proven by SPRT.

## Leave alone for now

These are fine as they are, or can't be improved without the harness:

- **Time manager** — soft/hard deadlines with stability scaling, bullet margins
  already tuned (`MOVE_OVERHEAD_MS = 100`, `HARD_MULT = 3`).
- **Opening book** (`src/book.cpp`, Cerebellum downloaded in the Docker build).
- **TT internals** — lockless XOR slots and 16-bit move packing are fine; only
  replacement policy matters (doc 05).
- **Lazy SMP, aspiration window sizes, LMR table, RFP/futility/LMP margins** —
  tuning knobs. Don't touch until SPRT can measure them.
- **`move.cpp`, `bench.cpp`, UCI parsing.** (Known nit: `position` received
  mid-search mutates the board under the search thread. The backend always
  waits for `bestmove`, so it doesn't happen in practice.)

## Testing harness

Built 2026-10-29 (it was doc 01, deleted once finished; "doc 01" in the other
docs means this section). Four checks, cheapest first. Run them all from
`engines/jewkiebot/` in Git Bash. The MSYS2 UCRT64 toolchain
(`C:\msys64\ucrt64\bin`) must be on PATH.

| Check | Command | What it proves |
| --- | --- | --- |
| Build + unit tests | `scripts/build.sh`, `scripts/test.sh [regex]` | Compiles; ctest `-L tests` (`perft_test` included) |
| Perft | `scripts/run.sh`, then `position startpos` + `perft 5` | Move generation is correct: node counts must match the known values (`tests/perft_test.cpp`). Prints a count per root move ("divide") to find which move is wrong |
| Bench | `scripts/run.sh`, then `bench` | The `Bench: <nodes>` fingerprint. A refactor or speed-up must keep it; a change that alters it says so in its commit message |
| Tactics | `bun scripts/tactics.ts [--movetime 500]` | "Did I break tactics": 200 Stockfish-verified Lichess puzzles + bug regressions. Same code scores 190–196/200 at 500 ms, so only a drop below ~188 is a red flag. Regressions must stay solved |
| SPRT | `scripts/sprt.sh <base> <new> [stc\|ltc] [gainer\|simplify\|sanity]` | Whether the change is actually stronger. Appends to [results.md](results.md) |

**SPRT.** Refs are git refs or `working` (the working tree as is). Both sides
get built in worktrees under `tools/sprt/`; they play from `UHO_4060_v1.epd` with
colors swapped per opening, at `Threads=1`, `OwnBook=false`.

- STC is 8+0.08 with Hash 16; LTC is 40+0.4 with Hash 64. Re-test search
  changes that pass STC at LTC.
- `gainer` = elo0 0, elo1 5 ("prove it's better"); `simplify` = −5/0 ("prove it
  isn't worse"); alpha = beta = 0.05. Big early changes (docs 02–04) could use
  0/10 to finish sooner.
- Run with the machine otherwise idle (default concurrency is cores/2 − 1). If
  several games lose on time at the same moment, the machine stalled: check the
  PGN's `GameEndTime`.

**Tools.** Both are git-ignored, under `engines/jewkiebot/tools/`:

- fastchess 1.8.2 (github.com/Disservin/fastchess releases), in
  `tools/fastchess/fastchess-windows-x86-64/`
- `UHO_4060_v1.epd` (github.com/official-stockfish/books)

Rebuilding the tactical suite is rarely needed:
- `bun scripts/tactics-fetch.ts` samples the Lichess puzzle database.
- `bun scripts/tactics-verify.ts` drops anything Stockfish disagrees with. Run it with the machine idle.

New bug positions go in `tests/tactics/regressions.epd`.

**UCI gotchas** (harmless so far):
- `ucinewgame` prints `newgame` and unknown commands print `no dispatch`. Neither is valid UCI.
- `OwnBook` defaults to `true` but does nothing until `BookFile` is set.
- `go nodes N` is ignored.
- `position` received mid-search mutates the board under the search thread.

`build-*` and `build/` are git-ignored. The production image builds with `g++` on Debian in
`docker/jewkiebot.Dockerfile` (dss repo).
