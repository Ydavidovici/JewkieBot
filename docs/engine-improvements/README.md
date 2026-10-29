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

## Baseline measurements (2026-10-28)

Taken with `engines/jewkiebot/build/jewkiebot.exe` (built 2026-10-17, matches
current source), 1 thread, on the dev laptop (16 logical cores). Re-run these
after every change — they're the cheap sanity check before an SPRT match.

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
| 1 | [01-testing-harness.md](01-testing-harness.md) | Perft + SPRT self-play harness | Small–medium | (enabler) | Not started |
| 2 | [02-castling-legality-bug.md](02-castling-legality-bug.md) | Search castles out of / through check | ~10 lines | +20–60 | **Bug confirmed**, not fixed |
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

## Building and testing locally

The MSYS2 UCRT64 toolchain is installed (`C:\msys64\ucrt64\bin` on PATH):

```bash
cd engines/jewkiebot
cmake -S . -B build-gcc -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build-gcc
ctest --test-dir build-gcc -L tests        # 6 suites, ~40 s
./build-gcc/jewkiebot.exe                  # UCI; try: bench depth 10
```

`build-*` is git-ignored. The production image builds with `g++` on Debian in
`docker/jewkiebot.Dockerfile` (dss repo).
