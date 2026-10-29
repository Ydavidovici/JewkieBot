# 08 — Raw speed: magic bitboards, incremental eval, build flags

**Status:** not started
**Effort:** medium
**Elo:** roughly +10–30 (speed is not the main constraint yet)

## Summary

At ~0.9M nodes/s (1 thread) the engine is reasonably fast for a hand-written
bitboard engine. Doubling speed is worth roughly +50–70 Elo in typical
engines, but realistic gains here are 20–40%, so expect +10–30. Do this after
docs 02–05: those change what the engine searches; this only changes how
fast. **Every change in this doc must leave the bench node count identical**
(doc 01, layer 2) — they're pure speed-ups.

## Where the time goes (estimates, to be profiled)

- **Evaluation** runs at every node (static eval in `negamax`, stand-pat in
  `quiescence`). Measured ~780k evals/s standalone vs ~0.9M nodes/s total, so
  eval is a large share of runtime. It's recomputed from scratch each time:
  loops over all pieces for material+PST, recomputes slider attacks for
  mobility, walks pawns for structure.
- **Slider attacks** (`rayAttacks`, board.cpp ~79) use the classical ray
  method: 4 table lookups + bit scans per rook/bishop attack set. They're
  called in move generation, `isSquareAttacked` (on **every** `makeMove` for
  the legality check), and mobility.
- **Quiescence** generates all moves then filters (doc 03 §6).

Before optimizing, **profile**: with MSYS2's toolchain, build with
`-pg` (gprof) or use Windows' `perf`-like tools (e.g. Very Sleepy, or
`perf` on the Linux host) on `bench depth 12`. Optimize what the profile says.

## Items

### 8.1 Magic bitboards

Replace ray scanning with one multiply-shift-lookup per slider:
`attacks = table[sq][((occ & mask[sq]) * magic[sq]) >> shift[sq]]`.
Rook tables ~800 KB, bishop ~40 KB (with "fancy" magics). Well-known magic
numbers are published (Chess Programming Wiki "Magic Bitboards", or generate
them at startup with a short random search).

Alternative: **PEXT** bitboards (`_pext_u64`, BMI2) — simpler and faster on
Intel Haswell+ / AMD Zen 3+, **very slow** on AMD Zen 1/2. Requires knowing
the server's CPU; magics are the portable default. Could select at build time.

Drop-in: `rookAttacks`/`bishopAttacks` keep their signatures, so nothing
else changes. Verify with perft (doc 01) + identical bench node count.

### 8.2 Incremental material and PST

Keep running `mg`/`eg` material+PST sums in `Board`, updated in
`makeMove`/`unmakeMove` (add/remove the piece-square value for each piece
moved, captured or promoted). `evaluate` then starts from those sums instead
of looping over every piece. Pairs naturally with doc 04's MG/EG tables (the
board needs read access to the evaluator's tables — e.g. pass a pointer, or
keep the tables static). Undo can store the previous sums.

Phase can be incremental too.

### 8.3 Pawn hash table

Pawn structure (doubled/isolated/passed) depends only on pawn positions,
which change rarely. Keep a Zobrist key of pawns only, and a small cache
(e.g. 16k entries) of `pawnKey → (mg, eg, passedPawnBitboards)`. Hit rates are
typically >95%. Becomes more valuable as pawn evaluation grows (doc 04/06).

### 8.4 Cheaper legality

Every `makeMove` calls `isSquareAttacked(findKing(...))` after applying the
move (board.cpp ~749). Faster scheme: compute pinned pieces and checkers once
per node; a non-king move that isn't pinned (and isn't en passant) when not
in check is always legal — skip the attack test. King moves still need the
test. Larger refactor; measure first.

### 8.5 Captures-only generator for quiescence

See doc 03 §6.

### 8.6 Build flags

`CMakeLists.txt` sets `-O3 -DNDEBUG` (plus `-g` globally). Options:

| Flag | Gain | Caveat |
| --- | --- | --- |
| `-march=x86-64-v2` / `-v3` | `popcnt`/`tzcnt`/`lzcnt` as single instructions (v2 has popcnt; v3 adds BMI1/2, AVX2) | Binary won't run on older CPUs. The Docker image builds on the server for the server, so matching the server's CPU is fine. Check its flags (`grep flags /proc/cpuinfo`) |
| `-flto` | Cross-file inlining (board/eval/search are separate static libs today) | Longer builds |
| PGO (`-fprofile-generate` → run `bench` → `-fprofile-use`) | Often 5–15% | Two-step build; worth it for release builds only |
| `-funroll-loops` | Marginal | Measure |

`-march=native` must **not** be used in the Docker build unless the build
host is the run host (it is today — the image is built on the server — but
that's a fragile assumption).

## Verification

For every item:
1. Perft counts unchanged (8.1, 8.4, 8.5).
2. `bench` **node count identical** to before.
3. `bench` NPS higher — run 3× and compare medians; laptop thermals add noise.
4. SPRT as a simplification (`elo0=-5 elo1=0`) is optional for pure speed-ups
   with identical node counts, but a quick STC run catches surprises.

## Open questions

- Server CPU model (for `-march` level and PEXT vs magics)?
- Is anyone relying on the `-g` debug info in release builds? (It doesn't slow
  the binary, only enlarges it.)
