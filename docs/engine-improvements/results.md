# Engine SPRT results

One line per `scripts/sprt.sh` run, newest last. Elo is new vs base. Full logs
and PGNs stay local in `engines/jewkiebot/tools/sprt/`.

| Date | Base | New | TC | Mode | Games | Elo | LLR | Verdict | Bench (base → new) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-29 | working 3154a3c+wt | working 3154a3c+wt | 8+0.08 | sanity | Games: 200, Wins: 75, Losses: 69, Draws: 56, Points: 103.0 (51.50 %) | Elo: 10.43 +/- 40.16, nElo: 12.56 +/- 48.15 | - | sanity (fixed games): plumbing OK — 0 crashes, 0 illegal moves, Elo consistent with 0. 7 time losses: 2 tiny (1 ms, 12 ms); 5 huge (~130 s) all ended at 14:33:09–19, a machine-wide stall, not the engine. Logged by hand (sprt.sh then exited early on fastchess's non-zero status; fixed) | 17250320 → 17250320 |
| 2026-10-29 | dev b9e0725 | working b9e0725+wt | 8+0.08 | gainer | Games: 8050, Wins: 2924, Losses: 2715, Draws: 2411, Points: 4129.5 (51.30 %) | Elo: 9.02 +/- 6.00, nElo: 11.43 +/- 7.59 | LLR: 2.97 (100.9%) (-2.94, 2.94) [0.00, 5.00] | H1 was accepted | 17250320 → 16371041 |
| 2026-10-29 | dev b9e0725 | working b9e0725+wt | 8+0.08 | gainer | Games: 8050, Wins: 2924, Losses: 2715, Draws: 2411, Points: 4129.5 (51.30 %) | Elo: 9.02 +/- 6.00, nElo: 11.43 +/- 7.59 | LLR: 2.97 (100.9%) (-2.94, 2.94) [0.00, 5.00] | H1 was accepted. Doc 02 castling fix. 60 time losses (0.7%, small overruns, both sides). Logged by hand: the sprt.sh shell was stopped for low memory, fastchess kept running | 17250320 → 16371041 |
| 2026-10-30 | fbc3d60 fbc3d60 | c122ce4 c122ce4 | 8+0.08 | big | Games: 520, Wins: 223, Losses: 131, Draws: 166, Points: 306.0 (58.85 %) | Elo: 62.12 +/- 24.66, nElo: 76.99 +/- 29.86 | LLR: 2.95 (100.3%) (-2.94, 2.94) [0.00, 10.00] | H1 was accepted | 16371041 → 10870295 |
| 2026-10-29 | fbc3d60 fbc3d60 | c122ce4 c122ce4 | 8+0.08 | big | Games: 520, Wins: 223, Losses: 131, Draws: 166, Points: 306.0 (58.85 %) | Elo: 62.12 +/- 24.66, nElo: 76.99 +/- 29.86 | LLR: 2.95 (100.3%) (-2.94, 2.94) [0.00, 10.00] | H1 was accepted. Doc 03 part 1, SEE pruning in quiescence. Laptop slept after 472 games; 21 of 23 time losses were 7-game batches at each wake-up (01:31, 05:31, 11:37). Without those 28 games: W208 L120 D164, about +62, unchanged. Logged by hand: the sprt.sh shell was stopped for low memory | 16371041 → 10870295 |
