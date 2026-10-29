# Engine SPRT results

One line per `scripts/sprt.sh` run, newest last. Elo is new vs base. Full logs
and PGNs stay local in `engines/jewkiebot/tools/sprt/`.

| Date | Base | New | TC | Mode | Games | Elo | LLR | Verdict | Bench (base → new) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-29 | working 3154a3c+wt | working 3154a3c+wt | 8+0.08 | sanity | Games: 200, Wins: 75, Losses: 69, Draws: 56, Points: 103.0 (51.50 %) | Elo: 10.43 +/- 40.16, nElo: 12.56 +/- 48.15 | - | sanity (fixed games): plumbing OK — 0 crashes, 0 illegal moves, Elo consistent with 0. 7 time losses: 2 tiny (1 ms, 12 ms); 5 huge (~130 s) all ended at 14:33:09–19, a machine-wide stall, not the engine. Logged by hand (sprt.sh then exited early on fastchess's non-zero status; fixed) | 17250320 → 17250320 |
