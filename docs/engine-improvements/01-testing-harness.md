# 01 — Testing harness: perft, bench fingerprint, and SPRT

**Status:** not started
**Effort:** small–medium
**Elo:** none directly — this is what makes every other doc measurable

## Why this matters

Almost every engine change moves strength by 5–30 Elo. A 10 Elo difference
means the better version scores about 51.4% against the worse one. You cannot
see that by watching games, or even by playing 50 or 100 of them: with 100
games the 95% error bar is roughly ±70 Elo. Changes that *look* like
improvements in a handful of games are regularly small regressions.

Every serious engine project therefore tests each change the same way: play
the new build against the previous build at a fast time control, thousands of
games if needed, and stop as soon as the result is statistically decided. The
stopping rule is **SPRT** (sequential probability ratio test).

Without this, docs 03–09 are educated guesses. With it, each one gets a clear
"merge" or "revert".

## The four layers

Testing is layered from cheapest/fastest to most expensive. Each layer catches
different mistakes.

### Layer 1 — Perft (move-generation correctness)

**What it is:** count every legal move sequence to depth N from a set of
standard positions and compare against known-correct counts. If move
generation, make/unmake, castling, en passant or promotions are wrong
anywhere, the counts differ.

**What exists today:** `tests/board_move_tests.cpp` has hand-written cases
(`test_castling_rules`, `test_en_passant_rules`, `test_pins_and_illegal_due_to_self_check`, …)
but **no perft**. Those tests call `generateLegalMoves()` — the slow, fully
legal generator used only at the root. The search uses a different path:
`generatePseudoMoves()` + `makeMove()` rejecting moves that leave the king in
check. **That's exactly why the castling bug (doc 02) slipped through**: the
tested path is correct, the path the search actually uses isn't.

**Design:** add a `perft` that walks the *search* path:

```cpp
// Mirrors how negamax enumerates moves: pseudo-legal generation, legality
// decided by makeMove().
uint64_t perft(Board& board, int depth) {
    if (depth == 0) return 1;
    MoveList moves;
    board.generatePseudoMoves(moves);
    uint64_t nodes = 0;
    for (const Move& m : moves) {
        if (!board.makeMove(m)) continue;
        nodes += perft(board, depth - 1);
        board.unmakeMove();
    }
    return nodes;
}
```

Also add a `perft <depth>` UCI command that prints a "divide" (count per root
move), which makes hunting a mismatch against Stockfish's `go perft N` easy.

**Reference positions and counts** (the standard set from the Chess
Programming Wiki "Perft Results" page — double-check against the page when
adding them):

| Name | FEN | Depth → nodes |
| --- | --- | --- |
| Start | `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` | 1: 20 · 2: 400 · 3: 8,902 · 4: 197,281 · 5: 4,865,609 |
| Kiwipete | `r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1` | 1: 48 · 2: 2,039 · 3: 97,862 · 4: 4,085,603 |
| Position 3 | `8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1` | 1: 14 · 2: 191 · 3: 2,812 · 4: 43,238 · 5: 674,624 |
| Position 4 | `r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1` | 1: 6 · 2: 264 · 3: 9,467 · 4: 422,333 |
| Position 5 | `rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8` | 1: 44 · 2: 1,486 · 3: 62,379 · 4: 2,103,487 |
| Position 6 | `r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P3/2NP1N2/PPP1QPPP/R4RK1 w - - 0 10` | 1: 46 · 2: 2,079 · 3: 89,890 · 4: 3,894,594 |

Kiwipete and Position 4 are the castling/en-passant torture tests. **Expect
the current engine to fail some of these through the search path** because of
doc 02 — that's the first useful thing this harness will do.

Put it in a new `tests/perft_test.cpp`, labelled `tests` in CMake so
`ctest -L tests` runs it. Keep depths small enough to finish in a few seconds
(depth 4 for most).

### Layer 2 — Bench fingerprint (catch accidental behavior changes)

`bench` already exists (`src/bench.cpp`, 3 FENs). With `Threads 1` the search
is deterministic, so **total node count at a fixed depth is a fingerprint of
search behavior**. Two rules follow:

- A change meant to be a pure refactor or speed-up (e.g. doc 08) must leave
  the bench node count **identical**. If it changes, something changed
  behavior.
- A change meant to alter search/eval *should* change it — record the new
  number in the commit message (`Bench: 2493373`), like Stockfish does. Then
  anyone can verify a build matches a commit.

Improvements to make:

- Expand `BENCH_FENS` from 3 to ~30–50 varied positions (opening, middlegame,
  tactical, endgame). Three positions is too few to be a stable fingerprint
  and too few to judge NPS.
- Make `bench` force `Threads 1` and clear the TT before each position, so the
  number doesn't depend on settings or order.
- Print a final single line `Bench: <nodes> nodes <nps> nps` that scripts can
  grep.

### Layer 3 — Tactical sanity suite (quick "did I break tactics")

An EPD file of positions with known best moves (e.g. "Win At Chess" WAC 300,
or a set of mate-in-N positions), run at a fixed short time per position,
reporting how many are solved. Not a strength measure — a smoke test. A
change that drops the solve count sharply is broken even if it hasn't been
SPRT'd yet. Add our own regression positions here as we find bugs (the doc 02
mate-in-1 goes in on day one).

Could be a `--epd <file> --movetime <ms>` mode in the engine or a small
script driving UCI. Lower priority than layers 1, 2 and 4.

### Layer 4 — SPRT self-play (the actual strength test)

**How SPRT works:** you state two hypotheses — H0 "the change gains at most
`elo0`" and H1 "the change gains at least `elo1`" — and acceptable error rates
(`alpha` = chance of accepting a useless change, `beta` = chance of rejecting
a good one). After each game the test computes a log-likelihood ratio (LLR).
When LLR crosses the upper bound, H1 is accepted (merge); the lower bound,
H0 (reject). Big real improvements finish in a few hundred games; changes
near zero take many thousands, which is the point — it spends games only
where the answer is unclear.

**Standard settings:**

| Kind of change | `elo0` | `elo1` | Meaning |
| --- | --- | --- | --- |
| New feature / gainer | 0 | 5 | "Prove it's better" |
| Simplification / refactor / speed-up | -5 | 0 | "Prove it isn't worse" |
| Early, large changes (docs 02–04) | 0 | 10 | Finishes faster when the gain is big |

`alpha = beta = 0.05`.

**Time controls:**

- **STC** (short): `8+0.08` (8 s + 0.08 s/move). Most tests run here.
- **LTC** (long): `40+0.4`. Re-test search changes that pass STC here — some
  pruning ideas gain at fast TC and lose at slow TC.

Each engine gets `Threads=1`, `Hash=16` at STC (64 at LTC), `OwnBook=false`.
Concurrency = physical cores minus 1–2 so games don't steal time from each
other (this laptop: 16 logical cores → try 12).

**Openings:** a balanced-but-unbalanced book so games aren't all draws and
aren't decided by the opening: `UHO_4060_v1.epd` (from the official Stockfish
`books` repository). Self-play already expects it at `tools/UHO_4060_v1.epd`
(`backend/src/controllers/selfPlayController.ts`, `defaultRemoteConfig`), and
`.gitignore` already ignores `/tools/*.epd`. Always play each opening twice
with colors swapped (`-repeat`) — that cancels most opening bias.

**Tool:** use **fastchess** (actively maintained cutechess successor, built
for SPRT, has Windows binaries) or **cutechess-cli** (already used by the
backend's gauntlet/self-play controllers). Example with fastchess:

```bash
fastchess \
  -engine cmd=./build-new/jewkiebot.exe name=new \
  -engine cmd=./build-base/jewkiebot.exe name=base \
  -each tc=8+0.08 option.Threads=1 option.Hash=16 option.OwnBook=false \
  -openings file=tools/UHO_4060_v1.epd format=epd order=random \
  -repeat -rounds 20000 -concurrency 12 \
  -sprt elo0=0 elo1=5 alpha=0.05 beta=0.05 \
  -pgnout file=sprt.pgn
```

cutechess-cli equivalent: same `-engine`/`-each`/`-openings`/`-repeat`/`-sprt`
flags, plus `proto=uci` in `-each` and `-games 2`.

## Proposed workflow script

`engines/jewkiebot/scripts/sprt.sh <base-ref> <new-ref> [stc|ltc] [gainer|simplify]`

1. `git worktree add` both refs into temporary directories (so the working
   tree isn't disturbed).
2. Build each with the Release config into its own `build-*` dir.
3. Run `bench` on each and print both fingerprints.
4. Run fastchess with the settings above.
5. Append a line to `docs/engine-improvements/results.md`:
   date, base, new, TC, games, W/L/D, Elo ± error, LLR, verdict.
6. Remove the worktrees.

Typical use while working on doc 03: commit SEE on a branch, then
`scripts/sprt.sh dev see-qsearch stc gainer`.

## Where to run it

| Option | Pros | Cons |
| --- | --- | --- |
| This laptop (Windows, 16 logical cores) | Fastest feedback, no SSH | Laptop busy for minutes to hours; thermal throttling can skew long runs |
| The existing remote self-play host (`selfPlayController.ts`, over SSH) | Already has cutechess, repo checkout, build-on-demand by tag | Only knows release tags + "current"; needs SPRT flags and per-branch builds added |
| The DSS server | Always on | It's production — matches would slow live games. Avoid |

Recommendation: start local (simplest, fastest iteration). Later, teach the
remote self-play controller an SPRT mode so long LTC runs can go off-laptop
and show up in the dashboard.

## Setup checklist

- [ ] Download fastchess (Windows release) into `engines/jewkiebot/tools/`; add `/tools/fastchess*` to `.gitignore`
- [ ] Download `UHO_4060_v1.epd` into `engines/jewkiebot/tools/` (already ignored)
- [ ] Add `tests/perft_test.cpp` (search-path perft, table above) + `perft` UCI command with divide
- [ ] Expand `BENCH_FENS`; force Threads 1 + TT clear in bench; print a greppable `Bench:` line
- [ ] Write `scripts/sprt.sh`
- [ ] Create `docs/engine-improvements/results.md` and log every run
- [ ] Sanity run: SPRT the current `dev` against itself — should end near 0 Elo (and, with `elo0=0 elo1=5`, eventually reject). Proves the plumbing is fair.

## Gotchas noticed in the engine's UCI layer

- `ucinewgame` prints `newgame` and unknown commands print `no dispatch` —
  neither is valid UCI output. fastchess/cutechess usually ignore them, but if
  either logs warnings or misbehaves, remove those prints.
- `OwnBook` is advertised as default `true` but does nothing until `BookFile`
  is set (TODO in `main.h`). Pass `option.OwnBook=false` explicitly anyway.
- `go nodes N` is parsed but ignored (TODO in `handle_go`). Fixed-node matches
  aren't needed for SPRT, but implementing it would help datagen (doc 09).
- `position` arriving mid-search mutates the board under the search thread.
  Match runners always wait for `bestmove`, so it's not a practical issue.

## Open questions

- Laptop or remote host for routine runs?
- How many cores can the laptop give to matches without being unusable?
- Do we want the results log in the repo (shared history) or local only?
