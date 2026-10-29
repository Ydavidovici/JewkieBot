# 07 — Production configuration: threads, hash, pondering

**Status:** not started
**Effort:** tiny (threads/hash) · medium (pondering)
**Elo:** unknown for threads — possibly large under load · roughly +30–50 in real games for pondering

## Summary

How the backend runs the engine on Lichess can cost as much strength as
engine code. Two issues:

1. The backend never tells the engine how many threads to use, so **every
   engine process uses every CPU core** — and several run at once.
2. The engine never **ponders** (thinks on the opponent's time).

## Part A — Threads and hash

### What happens today

- `Search::Search` sets `numThreads_ = std::max(1u, std::thread::hardware_concurrency())`
  (search.cpp ~152). Default = all logical cores.
- The UCI handler supports `setoption name Threads` and `setoption name Hash`
  (main.cpp `handle_setoption`).
- The backend's `UciEngine.start()` (`backend/src/engineManager.ts` ~97–111)
  sends `uci`, the book options, `EvalParamsFile`, and `isready` — **never
  `Threads` or `Hash`**.
- Each Lichess game gets its own engine process via `lichessEngineFactory` →
  `engineManager.reserveEngine(...)` (`backend/src/server.ts`). Up to
  `LICHESS_MAX_GAMES` (default 5) games at once; engine cap
  `ENGINE_HARD_CAP` = max games + 3. Plus the long-lived "Main" engine used for
  analysis.
- Hash defaults to 64 MB per engine.

So with 5 games in progress on an N-core server, up to 5 engines each run N
search threads whenever it's their turn. Turns overlap, so threads fight for
cores, every search gets fewer nodes than it thinks, and lazy SMP's helpers
mostly add contention. With 1 game it's fine; with several it can be a large
loss — and it's invisible in logs.

Also: the server runs the whole DSS stack (nginx, postgres, db-service, other
apps). Engines competing with those adds latency to everything.

### What we don't know yet

- **How many cores the server has** (and whether Docker limits CPU for the
  container). Easiest: run `nproc` on the server (the log key in
  `dss/scripts/server/dss-logs.sh` could get an `nproc`/`cpuinfo` command), or
  `docker exec dss-jewkiebot-prod nproc`.
- Whether `REMOTE_ENGINE_ENABLED` is on in prod (engines over SSH on another
  host change the arithmetic — then it's that host's cores).

### Design

1. Add env vars in the backend, read in `engineManager.ts`:
   - `ENGINE_THREADS` — threads per **game** engine. Default:
     `max(1, floor(availableCores / LICHESS_MAX_GAMES))`, or simply 1.
   - `ENGINE_HASH_MB` — default 64 (fine; raise if RAM allows).
   - Optionally separate `MAIN_ENGINE_THREADS` for the analysis engine.
2. In `UciEngine.start()`, after `uci` and before `isready`:
   ```ts
   await this._sendCommand({command: `setoption name Threads value ${threads}`});
   await this._sendCommand({command: `setoption name Hash value ${hashMb}`});
   ```
3. Log the chosen values at startup (`[Engine] Threads=… Hash=…`).
4. Consider Docker `cpus:` limits for the jewkiebot containers so engines
   can't starve nginx/postgres.

Note: with lazy SMP, 1 thread → 2 threads is worth a decent amount (roughly
+50–80 Elo in typical engines), 2 → 4 less. So if the server has, say, 4
cores and you usually play 1–2 games at a time, 2 threads per engine is a
sensible default.

### Verification

- Engine startup logs show the configured values.
- `info … nps` in game logs stays roughly constant whether 1 or 5 games run
  (today it should drop sharply with more games — worth measuring first as a
  baseline: compare NPS in the `[HTTP]`/notifier logs during busy vs quiet
  periods, or log NPS per move).

## Part B — Pondering

### What it is

While the opponent is thinking, the engine guesses their most likely reply
(the second move of its own PV), makes it on its board, and starts searching
the resulting position. If the opponent plays the predicted move
("ponderhit"), the engine has a head start — often the entire think time of
the opponent. If not, it stops and searches normally. Typical prediction rate
is 30–50%.

### What's needed

**Engine (UCI):**
- Parse `go ponder …` in `handle_go` (main.cpp) — today `ponder` is ignored,
  so it would just search with the normal time limit.
- On `go ponder`: start the search with an **infinite** time manager.
- On `ponderhit`: switch the time manager to the real clock — start the
  normal soft/hard allocation from now, counting time already spent as a
  bonus (it's free).
- On `stop` during ponder: return `bestmove` immediately (discarded by the
  backend).
- Advertise `option name Ponder type check default false` in `handle_uci`.
- Emit `bestmove X ponder Y` (Y = second PV move) so the backend knows what to
  ponder.

**Backend (`lichessBot.ts`, `engineManager.ts`):**
- After sending our move, if the engine gave a ponder move: send
  `position … moves … ourMove ponderMove` and `go ponder wtime … btime …`.
- When the opponent's move arrives:
  - same as predicted → send `ponderhit`, await `bestmove` as usual;
  - different → send `stop`, discard the `bestmove`, then the normal
    `position` + `go`.
- The engine-command queue (`_sendCommand`) assumes one outstanding
  `go` → `bestmove`; pondering adds a second kind of pending search. Needs
  care so a stale `bestmove` from a cancelled ponder isn't taken as our move.
- Only ponder when the engine has its own cores; with many concurrent games
  (Part A) pondering multiplies CPU contention.

### Verification

- Unit tests for the new engine-manager state machine (ponderhit / miss /
  game end during ponder).
- In real games: log ponder hit rate and time saved.
- SPRT can't measure pondering directly (both sides would ponder); the gain
  shows in real games against other bots. Treat as "obviously beneficial if
  the CPU is free".

## Part C — Time management (low priority, mostly fine)

`src/timeManager.cpp` is reasonable: soft = remaining/40 + increment, hard =
3× soft (capped at 80% of remaining), stability scaling, 100 ms move overhead
for Lichess lag. Possible later refinements — only with SPRT at several TCs:
- predict whether the next iteration can finish before starting it (time per
  iteration grows ~2×; don't start one that can't complete);
- scale time by score instability (big score drop → think longer);
- check actual lag from Lichess (time reported vs. time used) to set the
  overhead from data.

## Open questions

- Server core count and Docker CPU limits?
- Is `REMOTE_ENGINE_ENABLED` used in prod?
- How many games does the bot typically play at once?
