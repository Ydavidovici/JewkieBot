# 05 — Search heuristics: ordering, history, transposition table, reductions

**Status:** not started
**Effort:** medium overall — a series of small, independent changes
**Elo:** roughly +5–25 each, +50–100 together

## Summary

The search already has the standard skeleton: iterative deepening, aspiration
windows, PVS, null-move pruning, reverse futility, futility, late move
pruning (LMP), late move reductions (LMR), check extension, killers, history,
a lockless TT, lazy SMP. What's missing is the second layer of refinements
modern engines rely on, plus one latent ordering bug. **Each item below must
be its own commit and its own SPRT run** (doc 01) — search changes interact in
surprising ways, and several of these only pay off in combination.

## Background: why move ordering is everything

Alpha-beta search only saves work when it tries the best move first: one good
move refutes the position ("beta cutoff") and the remaining moves are skipped.
Perfect ordering searches roughly the square root of the nodes of random
ordering. Today's ordering is decent — 89–93% of cutoffs happen on the first
move tried (`bench`, "Move Ordering") — but the heuristics feeding it are
basic, and reductions/pruning decisions (LMR, LMP) depend on ordering being
good *beyond* the first move.

Order of moves today (`Search::scoreMoves`, search.cpp ~733):

| Tier | Score |
| --- | --- |
| TT move | `ORDER_TT_MOVE` = 2,000,000 |
| Captures | `ORDER_CAPTURE_BASE` 1,000,000 + MVV-LVA |
| Promotions | 900,000 (+100 queen) |
| Killer 1 / 2 | 800,000 / 799,000 |
| Quiet moves | `history[side][from][to]` |

## Items

Listed roughly in the order to try them.

### 5.1 Bug: history can outrank the TT move, captures and killers

`history[side][from][to] += depth * depth` on every quiet beta cutoff
(search.cpp ~603), halved only once it exceeds
`HISTORY_SCORE_LIMIT = 10,000,000` (~59, ~605). The tiers above are 0.8–2
million. So in a long search a frequently-successful quiet move can climb past
2,000,000 and be tried **before the TT move**, and past every capture and
killer. It needs many cutoffs on the same from/to pair to happen (history is
reset each move — see 5.3), so it's rare today, but it gets *more* likely as
searches get longer and once history persists between moves.

**Fix:** bound history well below the killer tier. The standard way is the
"history gravity" update, which keeps values in `[-MAX, MAX]` automatically:

```cpp
constexpr int HISTORY_MAX = 16384;
void updateHistory(int& h, int bonus) {          // bonus may be negative (5.2)
    bonus = std::clamp(bonus, -HISTORY_MAX, HISTORY_MAX);
    h += bonus - h * std::abs(bonus) / HISTORY_MAX;
}
// bonus = std::min(depth * depth, 1200) or similar
```

With `|h| ≤ 16384`, quiet moves can never pass killers (799,000). Do this
first; it's a prerequisite for 5.2–5.4.

### 5.2 History malus

Today history only ever goes **up**. When a quiet move causes a cutoff, the
quiet moves tried *before* it in that node didn't — they should go **down**
by the same bonus. That's how history learns which moves are bad, not just
which are good. Track the quiets searched in the node (a small array) and
apply `updateHistory(h, -bonus)` to each at the cutoff.

### 5.3 Keep history and killers between moves

`findBestMove` allocates a fresh `std::vector<WorkerState>` and calls
`ws.reset()` (search.cpp ~255–256), which zeroes history and killers **every
move**. Each search re-learns everything from scratch.

**Fix:** make the worker states persistent members of `Search` (resized when
`Threads` changes). Between moves, don't zero history — divide it by 2 (or
leave it; gravity keeps it bounded). Killers are ply-indexed and the root ply
shifts by 2 each move; either clear them or shift them by 2. Clear everything
on `ucinewgame`.

### 5.4 Countermove and continuation history

Plain history asks "is moving from X to Y generally good?". Much sharper
signals:

- **Countermove:** "after the opponent's move M, which reply refuted it?"
  `countermove[pieceOf(M)][to(M)] = move` — one extra ordering tier just below
  killers.
- **Continuation history** (1-ply and 2-ply): history indexed by
  `[previous piece][previous to-square][this piece][this to-square]`. Its score
  is added to plain history when ordering quiets. This is a big part of why
  modern engines order quiets so well.

Both need the previous move(s) at each ply — add a small per-ply stack
(`Move`/piece played at ply N) to the search.

### 5.5 Transposition table replacement and aging

`TranspositionTable::store` (transpositionTable.cpp) replaces a slot only if
it's empty or the new depth is **≥** the stored depth. There's no age. The TT
is never cleared between moves or games (`ucinewgame` → `Engine::reset()` only
resets the board). So:

- deep entries from **earlier moves** (now irrelevant positions) can never be
  overwritten by shallower entries from the current search;
- over a long game — or a long-lived engine process across games — the table
  fills with stale deep results and current results get dropped.

**Fix:**
- add a generation counter (incremented each `findBestMove`), stored in the
  slot (there are free bits; or shrink depth to 7 bits);
- replace if: slot empty, **or** older generation, **or** `depth >= old depth - small margin`, **or** the new entry is EXACT;
- clear the TT on `ucinewgame`;
- optional: buckets of 2–4 slots per cache line, replacing the least valuable
  one (lowest `depth - age penalty`).

### 5.6 TT in quiescence, and storing more results

- Quiescence never probes or stores the TT, and it's 88% of nodes (doc 03).
  Probe at the top of `quiescence` (use a cutoff when the bound allows; use the
  move for ordering) and store the result with depth 0.
- Null-move cutoffs (search.cpp ~510–513) return without storing. Store them
  as a LOWERBOUND at the current depth — they're expensive to recompute.
- The reported "TT Hit Rate 1.8%" is misleading: probes/hits are only counted
  in `negamax`, and qsearch dominates the tree. A warm re-search of the same
  position used 5× fewer nodes, so the TT does work. Count qsearch probes too
  once 5.6 lands, so the stat means something.

### 5.7 Internal iterative reduction (IIR)

When a node at depth ≥ 4 has **no TT move**, its ordering will be poor, so
it's cheaper to search it one ply shallower now and let the TT fill in a move
for next time: `if (!ttMove.isValid() && depth >= 4) depth--;` (PV and cut
nodes). Small and usually a clear gain.

### 5.8 "Improving" flag

Store each ply's static eval in a per-ply stack. A node is *improving* if its
static eval is higher than two plies ago (same side to move). Then:
- reverse futility margin smaller when improving,
- LMP move limit larger when improving,
- LMR reduction one ply more when **not** improving.

Requires the static-eval stack, which 5.4's ply stack can share.

### 5.9 LMR refinements

Today the reduction (search.cpp ~556–563) depends only on depth and move
number, minus one at PV nodes. Usual additions, each a separate test:
- reduce less for moves with high history, more for low/negative history
  (`reduction -= history / 8192`);
- reduce more when not improving (5.8);
- reduce more for cut nodes;
- allow reducing bad captures (SEE < 0, doc 03), not just quiets.

### 5.10 Futility pruning shouldn't prune checking moves

`futilityApplies` (search.cpp ~527) prunes every quiet move in the node,
including quiet moves that **give check**. Checks are exactly the moves that
can change a hopeless-looking static eval. Skip pruning for moves that give
check. Needs a cheap "gives check?" test before making the move (or prune
after `makeMove` using `board.inCheck`, at some cost).

### 5.11 Null-move refinements

Current reduction: `3 + depth/6` (search.cpp ~40). Common improvements:
- add `min((staticEval - beta) / 200, 3)` — reduce more when far above beta;
- at high depth (≥ 12–14), verify a null-move cutoff with a reduced normal
  search, to avoid zugzwang errors in positions the big-piece check misses.

### 5.12 Singular extensions (later)

If the TT move is much better than every alternative ("singular"), extend it
by a ply. A large gain in strong engines, but it depends on a trustworthy TT
(5.5) and good ordering (5.1–5.4). Leave until those land.

### 5.13 Small correctness item: repetition across null moves

`Board::isRepetitionDraw()` scans back through `move_history` two plies at a
time, including across null-move entries (`makeNullMove` pushes an entry
with `moved_piece = PieceTypeCount`). A repeated position reached through a
null move isn't a real repetition. Stop the scan at a null-move entry.

## Suggested test order

1. 5.1 history bounds (+ gravity) — expect ~neutral to small gain; it's mostly a fix
2. 5.2 history malus
3. 5.3 persistent history/killers
4. 5.5 TT aging + clear on `ucinewgame`
5. 5.6 TT in qsearch + store null cutoffs
6. 5.7 IIR
7. 5.4 countermove, then continuation history
8. 5.8 improving
9. 5.9 / 5.10 / 5.11 one by one
10. 5.12 singular extensions
11. 5.13 whenever convenient (correctness)

Re-run `bench` after each and record the node count in the commit message.

## Verification per item

- `ctest -L tests` passes; perft unchanged (none of these touch move generation).
- `bench`: note node count and "Move Ordering" — ordering items (5.1–5.4)
  should raise first-move cutoff % or cut nodes at equal depth.
- SPRT `elo0=0 elo1=5` STC; pruning/reduction items (5.7–5.11) also at LTC.

## Open questions

- Gravity constants (HISTORY_MAX, bonus cap) — start with common values
  (16384, `min(depth*depth, 1200)`) and tune later with SPSA once the harness
  exists.
- How many history tables per worker thread is acceptable memory-wise?
  Continuation history at `[6][64][6][64]` ints is ~590 KB per worker — fine.
