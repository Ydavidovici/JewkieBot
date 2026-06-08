import {dbClient} from "./dbClient.js";
import {nullNotifier} from "./notifier.js";
import {OPENINGS} from "./openings.js";

export class LichessRateLimited extends Error {
    constructor(retryAfterSec) {
        super(`Lichess rate-limited; retry after ${retryAfterSec}s`);
        this.name = "LichessRateLimited";
        this.retryAfterSec = retryAfterSec;
    }
}

// this really normalizes promotion moves - so e7e8q becomes e7e8
export function normalizeMove(move) {
    if (move && move.length === 5) {
        return move.slice(0, 4) + move[4].toLowerCase();
    }
    return move;
}

export function mapResult(status, winner) {
    if (winner === "white")
        return "1-0";
    else if (winner === "black")
        return "0-1";
    else if (["draw", "stalemate", "threefoldRepetition", "insufficient", "fiftyMoves", "outoftime", "timeout"].includes(status))
        return "1/2-1/2";
    else return null
}

export class LichessBot {
    constructor(token, engineFactory, options = {}) {
        this.token = token;
        this.engineFactory = engineFactory;
        this.maxConcurrentGames = options.maxConcurrentGames ?? 4;
        this.huntPollIntervalMs = options.huntPollIntervalMs ?? 1000;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
        this.notifier = options.notifier ?? nullNotifier;

        // Cool-down for bots that ignored our challenges. We keep a map of username -> expiresAt so the pool builder can skip them on the next hunt.
        this.declineCooldownMs = options.declineCooldownMs ?? 15 * 60 * 1000;
        this.apiSpacingMs = options.apiSpacingMs ?? (process.env.NODE_ENV === "test" ? 0 : 1000);
        this._now = options.now || (() => Date.now());
        this.recentlyDeclined = new Map();

        // Minimum gap between consecutive challenge POSTs within one hunt.
        // Increased to 10 seconds to strictly respect Lichess's burst limits.
        this.challengeSpacingMs = options.challengeSpacingMs ?? 2000;
        // How long to wait, after all candidates are posted, for any of them to accept before giving up on the whole pool.
        this.huntAcceptTimeoutMs = options.huntAcceptTimeoutMs ?? 5000;
        this.lastChallengeTime = 0;
        // Fallback retry-after when Lichess sends a 429 without a Retry-After
        // header. Kept conservative so we don't immediately re-trigger.
        this.defaultRetryAfterSec = options.defaultRetryAfterSec ?? 150;

        // Cross-call rate-limit memory. When Lichess returns 429, any code
        // path that issues a challenge (autoplay AND manual /api/lichess/...
        // endpoints) checks this before posting so we don't burn 429s on
        // every caller during the cool-off window.
        this.rateLimitedUntil = 0;
        this.rateLimitConsecutiveHits = 0;
        this.rateLimitMaxMultiplier = options.rateLimitMaxMultiplier ?? 10;

        this.authHeader = {Authorization: `Bearer ${this.token}`};
        this.formHeaders = {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/x-www-form-urlencoded",
        };

        this.activeGames = new Set();
        this.botProfile = null;

        this.eventController = null;
        this.gameControllers = new Map();
        this.gameEngines = new Map();

        this.dbGameIds = new Map();
        this.savedPlies = new Map();
        this.gameOpenings = new Map();

        // Autoplay: when enabled, the bot fills free slots via huntWeakestBot.
        this.autoplay = null; // {limit, increment, rated, target, backoffMs, timer, huntInFlight}
    }

    startAutoplay({limit = 180, increment = 2, rated = true, target = 1, mode = "near", window = 200, whiteOpeningId = null, blackOpeningId = null} = {}) {
        this.stopAutoplay();

        // target = how many active games we'd like to keep going at once.
        // Capped by maxConcurrentGames as a safety.
        const cappedTarget = Math.min(target, this.maxConcurrentGames);

        this.autoplay = {limit, increment, rated, target: cappedTarget, mode, window, whiteOpeningId, blackOpeningId, currentBackoffMs: 0, timer: null, huntInFlight: false};

        this.notifier.info("[Autoplay] Autoplay enabled", {limit, increment, rated, target: cappedTarget, mode, window, whiteOpeningId, blackOpeningId});

        const whiteString = whiteOpeningId ? `white=${whiteOpeningId}` : "";
        const blackString = blackOpeningId ? `${whiteString ? ", " : ""}black=${blackOpeningId}` : "";
        const optionsString = whiteString || blackString ? `, ${whiteString}${blackString}` : "";

        console.log(`[Autoplay] Enabled (${limit}+${increment} ${rated ? "rated" : "casual"}, target=${cappedTarget}, mode=${mode}${mode === "near" ? `, window=±${window}` : ""}${optionsString})`);
        this._tickAutoplay();
    }

    stopAutoplay() {
        if (!this.autoplay) return;

        if (this.autoplay.timer) clearTimeout(this.autoplay.timer);

        this.autoplay = null;
        this.notifier.info("[Autoplay] Autoplay disabled");
        console.log("[Autoplay] Disabled");
    }

    autoplayStatus() {
        if (!this.autoplay) return {enabled: false};
        const {limit, increment, rated, target, mode, window, whiteOpeningId, blackOpeningId, currentBackoffMs, huntInFlight} = this.autoplay;
        return {enabled: true, limit, increment, rated, target, mode, window, whiteOpeningId, blackOpeningId, currentBackoffMs, huntInFlight, active: this.activeGames.size};
    }

    // Kick the autoplay loop. Idempotent. Called after every game ends and on a
    // slow safety-net timer so we recover even if nothing else triggers us.
    _tickAutoplay() {
        if (!this.autoplay) return;

        if (this.autoplay.timer) {
            clearTimeout(this.autoplay.timer);
            this.autoplay.timer = null;
        }

        // Already running enough games or already hunting? Just schedule a check.
        if (this.activeGames.size >= this.autoplay.target || this.autoplay.huntInFlight) {
            this.autoplay.timer = setTimeout(() => this._tickAutoplay(), 30_000);
            return;
        }

        // Honour any in-progress rate-limit window without even firing a hunt.
        if (this._isRateLimited()) {
            const remainingSec = this._rateLimitRemainingSec();
            const waitMs = remainingSec * 1000 + 500;
            this.notifier.warn("[Autoplay] Rate-limited; skipping tick", {remainingSec, waitMs});
            this.autoplay.timer = setTimeout(() => this._tickAutoplay(), waitMs);
            return;
        }

        this.autoplay.huntInFlight = true;

        const {limit, increment, rated, mode, window} = this.autoplay;

        const huntPromise = mode === "weakest"
            ? this.huntWeakestBot(limit, increment, rated)
            : this.huntNearRating(limit, increment, rated, {window});

        huntPromise
            .then(() => {
                if (!this.autoplay) return;
                this.autoplay.currentBackoffMs = 0;
            })
            .catch(err => {
                if (!this.autoplay) return;

                let next;

                if (err instanceof LichessRateLimited) {
                    // Honour Lichess's Retry-After instead of doubling, but
                    // never go below the existing exponential backoff (in
                    // case Lichess sends a short Retry-After while we're
                    // already backing off for other reasons).
                    next = Math.max(err.retryAfterSec * 1000 + 500, this.autoplay.currentBackoffMs || 0);
                    this.notifier.warn("[Hunt] Lichess rate limit", {retryAfterSec: err.retryAfterSec});
                } else {
                    // Exponential backoff: 30s, 60s, 120s.
                    next = this.autoplay.currentBackoffMs === 0 ? 30_000 : Math.min(this.autoplay.currentBackoffMs * 2, 120_000);
                }
                this.autoplay.currentBackoffMs = next;
                console.log(`[Autoplay] Hunt failed (${err.message}); retrying in ${next / 1000}s`);
            })
            .finally(() => {
                if (!this.autoplay) return;

                this.autoplay.huntInFlight = false;

                const wait = this.autoplay.currentBackoffMs || 10_000;
                this.autoplay.timer = setTimeout(() => this._tickAutoplay(), wait);
            });
    }

    async _loadRateLimitState() {
        if (process.env.NODE_ENV === "test") return;

        try {
            const file = Bun.file("lichess-rate-limit.json");
            if (await file.exists()) {
                const data = await file.json();
                if (data.rateLimitedUntil && data.rateLimitedUntil > this._now()) {
                    this.rateLimitedUntil = data.rateLimitedUntil;
                    // Do NOT restore consecutive-hit counter across restarts.
                    // The counter drives exponential backoff, but after a restart
                    // Lichess's rate-limit window has likely reset. Carrying the
                    // counter over means every restart-while-rate-limited pushes
                    // the multiplier higher (we saw hit #15 → 16-min backoffs).
                    // The saved rateLimitedUntil already encodes how long to wait;
                    // once that expires we start fresh at 1×.
                    const remainingSec = Math.ceil((this.rateLimitedUntil - this._now()) / 1000);
                    console.log(`[Bot] Restored rate limit state from disk: rate-limited for ${remainingSec}s`);
                }
            }
        } catch (err) {
            console.error("[Bot] Failed to load rate limit state:", err);
        }
    }

    async _saveRateLimitState() {
        if (process.env.NODE_ENV === "test") return;
        try {
            // Only persist the expiry timestamp — not the consecutive-hit counter.
            const data = {rateLimitedUntil: this.rateLimitedUntil};
            await Bun.write("lichess-rate-limit.json", JSON.stringify(data));
        } catch (err) {
            console.error("[Bot] Failed to save rate limit state:", err);
        }
    }

    async _ensureProfile() {
        if (this.botProfile) return true;

        if (this._isRateLimited()) return false;

        try {
            let res;
            try {
                res = await this._lichessFetch("https://lichess.org/api/account", {
                    headers: this.authHeader,
                });
            } catch (err) {
                if (err instanceof LichessRateLimited) return false;
            }
            if (res && res.ok) {
                const profile = await res.json();
                this.botProfile = profile.id;
                console.log(`[Bot] Logged in as: ${this.botProfile} (max ${this.maxConcurrentGames} concurrent games)`);
                return true;
            }
        } catch (_) {}
        return false;
    }

    async start() {
        console.log("[Bot] Starting...");
        await this._loadRateLimitState().catch(() => {});

        if (this._isRateLimited()) {
            this.botProfile = null;
            const waitSec = this._rateLimitRemainingSec();
            console.warn(`[Bot] Restored rate limit state from disk. Starting in rate-limited state for ${waitSec}s.`);
            setTimeout(() => this.streamEvents(), waitSec * 1000);
            return;
        }

        try {
            const res = await this._lichessFetch("https://lichess.org/api/account", {
                headers: this.authHeader,
            });
            if (!res.ok) {
                throw new Error(`Failed to fetch bot profile: Lichess returned HTTP ${res.status} (${res.statusText})`);
            }
            const profile = await res.json();
            this.botProfile = profile.id;
            console.log(`[Bot] Logged in as: ${this.botProfile} (max ${this.maxConcurrentGames} concurrent games)`);
        } catch (err) {
            if (err instanceof LichessRateLimited) {
                this.botProfile = null;
                console.warn(`[Bot] Started in rate-limited state. Will resolve profile in background.`);
            } else {
                throw err;
            }
        }

        this.streamEvents();
    }

    stop() {
        console.log("[Bot] Stopping...");
        this.stopAutoplay();

        if (this.eventController) {
            this.eventController.abort();
            this.eventController = null;
        }

        for (const [gameId, controller] of this.gameControllers) {
            controller.abort();
            console.log(`[${gameId}] Stream aborted.`);
        }
        this.gameControllers.clear();

        for (const [gameId, engine] of this.gameEngines) {
            engine.stop().catch(err => console.error(`[${gameId}] Engine stop error:`, err));
        }
        this.gameEngines.clear();

        this.activeGames.clear();
        this.dbGameIds.clear();
        this.savedPlies.clear();

        console.log("[Bot] Stopped.");
    }

    async streamEvents() {
        this.eventController = new AbortController();
        console.log("[Bot] Listening for events...");

        try {
            const res = await this._lichessFetch("https://lichess.org/api/stream/event", {
                headers: this.authHeader,
                signal: this.eventController.signal,
            });

            if (!res.ok) {
                console.error("[Bot] Event stream failed:", res.statusText);
                setTimeout(() => this.streamEvents(), this.reconnectDelayMs);
                return;
            }

            // Attempt to resolve profile since the event stream connected successfully
            if (!this.botProfile) {
                this._ensureProfile().catch(() => {});
            }

            await this.readNdjsonStream(res.body, this.eventController.signal, async (event) => {
                if (event.type === "challenge") {
                    await this.handleChallenge(event.challenge);
                } else if (event.type === "gameStart") {
                    this.playGame(event.game.id);
                }
            });
        } catch (err) {
            if (err.name === "AbortError") {
                console.log("[Bot] Event stream cancelled.");
                return;
            }
            console.error("[Bot] Event stream error:", err);
            let delay = this.reconnectDelayMs;
            if (this._isRateLimited()) {
                delay = Math.max(delay, this._rateLimitRemainingSec() * 1000);
            }
            setTimeout(() => this.streamEvents(), delay);
        }
    }

    async handleChallenge(challenge) {
        // Lichess emits challenge events for both directions. Outgoing ones are
        // tracked elsewhere (huntNearRating / huntWeakestBot poll activeGames);
        // we don't need to act on them here.
        if (challenge.direction === "out") return;

        const variant = challenge.variant?.key;

        // TODO: support variants
        if (variant !== "standard") {
            console.log(`[Challenge ${challenge.id}] Declining — unsupported variant: ${variant}`);
            await this.declineChallenge(challenge.id, "variant");
            return;
        }

        if (this.activeGames.size >= this.maxConcurrentGames) {
            console.log(`[Challenge ${challenge.id}] Declining — at max concurrent games (${this.maxConcurrentGames})`);
            this.notifier.info(`[Challenge] Declining challenge ${challenge.id}`, {reason: "at_cap", active: this.activeGames.size});
            await this.declineChallenge(challenge.id, "later");
            return;
        }

        console.log(`[Challenge ${challenge.id}] Accepting`);
        await this._throttleGlobalChallenge();
        await this._lichessFetch(`https://lichess.org/api/challenge/${challenge.id}/accept`, {
            method: "POST",
            headers: this.authHeader,
        });
    }

    async declineChallenge(challengeId, reason = "generic") {
        await this._throttleGlobalChallenge();
        const body = new URLSearchParams({reason});
        await this._lichessFetch(`https://lichess.org/api/challenge/${challengeId}/decline`, {
            method: "POST",
            headers: this.formHeaders,
            body,
        }).catch(() => {});
    }

    async playGame(gameId) {
        if (this.activeGames.has(gameId)) return;
        this.activeGames.add(gameId);
        
        console.log(`[${gameId}] Game started.`);
        this.notifier.info(`[Game] Game started: ${gameId}`, {active: this.activeGames.size, max: this.maxConcurrentGames});

        await this._ensureProfile().catch(() => {});

        const gameController = new AbortController();
        this.gameControllers.set(gameId, gameController);

        let engine;

        try {
            engine = this.engineFactory();
        } catch (err) {
            // EngineCapReached or any factory failure: don't try to play. Resign and bail.
            // Existing in-flight games keep running — we just don't add another.
            console.error(`[${gameId}] Engine factory rejected:`, err);
            this.notifier.warn(`[Game] Refused to spawn engine for ${gameId}`, {message: err?.message});
            try { await this.resignGame(gameId); } catch (_) {}
            this.activeGames.delete(gameId);
            this.gameControllers.delete(gameId);
            return;
        }
        this.gameEngines.set(gameId, engine);

        engine.on("fatal_error", async (err) => {
            console.error(`[${gameId}] !! ENGINE FATAL ERROR !! Resigning game.`, err);
            this.notifier.error(`[Game] Engine fatal in game ${gameId}`, {message: err?.message});
            try { await this.resignGame(gameId); } catch (_) {}
            gameController.abort();
        });

        let myColor = null;
        let initialFen = "startpos";
        let totalTimeMs = null;
        // Resign-on-stuck-engine: count consecutive failed move attempts so
        // we don't sit at the board burning clock when the engine produces
        // illegal/garbage moves indefinitely.
        const MAX_CONSECUTIVE_MOVE_FAILURES = 3;
        let consecutiveMoveFailures = 0;

        try {
            try {
                await engine.start();
                if (this.gameOpenings.get(gameId) === "balanced") {
                    await engine.setOption("OwnBook", "true");
                } else {
                    await engine.setOption("OwnBook", "false");
                }
            } catch (startErr) {
                console.error(`[${gameId}] !! ENGINE START FAILED !! Resigning game.`, startErr);
                try { await this.resignGame(gameId); } catch (_) {}
                throw startErr;
            }

            const res = await this._lichessFetch(`https://lichess.org/api/bot/game/stream/${gameId}`, {
                headers: this.authHeader,
                signal: gameController.signal,
            });

            await this.readNdjsonStream(res.body, gameController.signal, async (obj) => {
                if (obj.type === "chatLine" || obj.type === "opponentGone") return;

                let movesStr = "";
                let timeInfo = {};
                let status = "started";
                let winner = null;

                if (obj.type === "gameFull") {
                    const whiteUsername = obj.white?.id || obj.white?.name || "ai";
                    const blackUsername = obj.black?.id || obj.black?.name || "ai";
                    const myId = this.botProfile.toLowerCase();
                    myColor = whiteUsername.toLowerCase() === myId ? "white" : "black";
                    initialFen = obj.initialFen || "startpos";
                    movesStr = obj.state?.moves || "";
                    timeInfo = extractTime(obj.state);
                    status = obj.state?.status ?? "started";
                    winner = obj.state?.winner ?? null;

                    totalTimeMs = obj.clock?.initial ?? null;

                    await engine.uciNewGame();
                    await this.createDbGame(gameId, {
                        whiteUsername,
                        blackUsername,
                        variant: obj.variant?.key || "standard",
                        rated: obj.rated ? 1 : 0,
                        timeControl: obj.clock
                            ? `${obj.clock.initial / 1000}+${obj.clock.increment / 1000}`
                            : null,
                        whiteRating: obj.white?.rating ?? null,
                        blackRating: obj.black?.rating ?? null,
                    });

                    await this.saveNewMoves(gameId, movesStr);

                } else if (obj.type === "gameState") {
                    movesStr = obj.moves || "";
                    timeInfo = extractTime(obj);
                    status = obj.status ?? "started";
                    winner = obj.winner ?? null;

                    await this.saveNewMoves(gameId, movesStr);
                } else {
                    return;
                }

                if (status !== "started") {
                    const result = mapResult(status, winner);
                    console.log(`[${gameId}] Game over: ${status}, winner: ${winner ?? "draw"}`);
                    this.notifier.info(`[Game] Game over: ${gameId}`, {
                        status,
                        winner: winner ?? "draw",
                        result,
                        active: Math.max(0, this.activeGames.size - 1),
                    });
                    await this.finalizeDbGame(gameId, status, winner);
                    gameController.abort();
                    return;
                }

                if (myColor && this.isMyTurn(initialFen, movesStr, myColor)) {
                    const moveOk = await this.makeMove(engine, gameId, initialFen, movesStr, myColor, timeInfo, totalTimeMs);
                    if (moveOk) {
                        consecutiveMoveFailures = 0;
                    } else {
                        consecutiveMoveFailures++;
                        if (consecutiveMoveFailures >= MAX_CONSECUTIVE_MOVE_FAILURES) {
                            console.error(`[${gameId}] Engine stuck (${consecutiveMoveFailures} consecutive move failures) — resigning.`);
                            this.notifier.warn(`[Game] Engine stuck in ${gameId}, resigning`, {failures: consecutiveMoveFailures});
                            try { await this.resignGame(gameId); } catch (_) {}
                            gameController.abort();
                            return;
                        }
                    }
                }
            });

        } catch (err) {
            if (err.name !== "AbortError") {
                console.error(`[${gameId}] Game stream error:`, err);
            }
        } finally {
            try { await engine.stop(); } catch (e) { console.error(`[${gameId}] Engine stop error:`, e); }
            this.gameEngines.delete(gameId);
            this.activeGames.delete(gameId);
            this.gameOpenings.delete(gameId);
            this.gameControllers.delete(gameId);
            console.log(`[${gameId}] Cleaned up.`);
            this._tickAutoplay();
        }
    }

    /**
     * Returns true if the move was computed and accepted by Lichess; false
     * otherwise. Caller (playGame) tracks consecutive failures and resigns
     * if the engine appears stuck.
     *
     * @param {Object} engine - The chess engine instance
     * @param {string} gameId - The ID of the current game
     * @param {string} initialFen - The starting FEN position
     * @param {string} movesStr - Space-separated list of previous moves
     * @param {string} myColor - The color the bot is playing
     * @param {Object} timeInfo - Information about the remaining time and increment
     * @param {number} totalTimeMs - The total time allotted for the game
     * @returns {Promise<boolean>} Success of the move
     */
    async makeMove(engine, gameId, initialFen, movesStr, myColor, timeInfo, totalTimeMs) {
        console.log(`[${gameId}] My turn (${myColor}).`);

        const movesArray = movesStr.trim() === "" ? [] : movesStr.trim().split(" ");

        // Specific Opening Logic for Autoplay
        let currentOpeningId = this.gameOpenings.get(gameId);
        if (!currentOpeningId) {
            currentOpeningId = myColor === "w" || myColor === "white"
                ? (this.autoplay?.whiteOpeningId || "balanced")
                : (this.autoplay?.blackOpeningId || "balanced");

            if (currentOpeningId === "random_tactical" || currentOpeningId === "random_positional") {
                const targetStyle = currentOpeningId === "random_tactical" ? "tactical" : "positional";
                const choices = Object.keys(OPENINGS).filter(k => OPENINGS[k].style === targetStyle && OPENINGS[k].type !== "category");
                if (choices.length > 0) {
                    currentOpeningId = choices[Math.floor(Math.random() * choices.length)];
                }
            }
            this.gameOpenings.set(gameId, currentOpeningId);
            console.log(`[${gameId}] Selected opening: ${currentOpeningId} for ${myColor}`);
        }

        if (currentOpeningId !== "balanced" && OPENINGS[currentOpeningId]) {
            const expectedMoves = OPENINGS[currentOpeningId].moves;
            let matches = true;
            for (let i = 0; i < movesArray.length; i++) {
                if (movesArray[i] !== expectedMoves[i]) {
                    matches = false;
                    break;
                }
            }
            if (matches && movesArray.length < expectedMoves.length) {
                const nextMove = expectedMoves[movesArray.length];
                console.log(`[${gameId}] Forcing specific opening move: ${nextMove}`);
                return await this.sendMove(gameId, nextMove);
            }
        }

        try {
            await engine.position(initialFen, movesArray);
        } catch (err) {
            console.warn(`[${gameId}] position command failed: ${err.message}`);
            return false;
        }

        let rawMove;

        try {
            rawMove = await engine.go({
                whiteTime: timeInfo.wtime,
                blackTime: timeInfo.btime,
                whiteInc:  timeInfo.winc,
                blackInc:  timeInfo.binc,
            });
        } catch (err) {
            console.warn(`[${gameId}] go command failed: ${err.message}`);
            return false;
        }

        const bestMove = normalizeMove(rawMove);
        console.log(`[${gameId}] Engine: ${bestMove}`);

        if (!bestMove || bestMove === "(none)" || bestMove === "0000") {
            console.warn(`[${gameId}] No valid move — resigning.`);
            await this.resignGame(gameId);
            return false;
        }

        return await this.sendMove(gameId, bestMove);
    }

    isMyTurn(initialFen, movesString, myColor) {
        let startingColor = "white";
        if (initialFen && initialFen !== "startpos") {
            const parts = initialFen.split(" ");
            if (parts.length >= 2) startingColor = parts[1] === "w" ? "white" : "black";
        }
        const moveCount = movesString.trim() === "" ? 0 : movesString.trim().split(" ").length;
        const currentColor = moveCount % 2 === 0 ? startingColor : (startingColor === "white" ? "black" : "white");
        return currentColor === myColor;
    }

    // Returns true if Lichess accepted the move, false otherwise. Caller
    // decides what to do with repeated failures (typically: resign).
    async sendMove(gameId, move, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await this._lichessFetch(`https://lichess.org/api/bot/game/${gameId}/move/${move}`, {
                    method: "POST",
                    headers: this.authHeader,
                    timeoutMs: 5000,
                });
                if (!res.ok) {
                    const text = await res.text();
                    console.warn(`[${gameId}] Move rejected (${move}): HTTP ${res.status} ${text}`);
                    if (res.status >= 500) {
                        if (attempt < retries) {
                            await new Promise(r => setTimeout(r, 1000));
                            continue;
                        }
                    }
                    return false;
                }
                return true;
            } catch (err) {
                console.warn(`[${gameId}] Move API failed (${move}): ${err.message} (attempt ${attempt + 1}/${retries + 1})`);
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                return false;
            }
        }
        return false;
    }

    async resignGame(gameId) {
        await this._lichessFetch(`https://lichess.org/api/bot/game/${gameId}/resign`, {
            method: "POST",
            headers: this.authHeader,
        }).catch(() => {});
    }

    async createDbGame(lichessGameId, {whiteUsername, blackUsername, variant, rated, timeControl, whiteRating, blackRating}) {
        try {
            const game = await dbClient.createGame({lichessGameId, whiteUsername, blackUsername, variant, rated, timeControl, whiteRating, blackRating, env: process.env.APP_ENV || "prod", source: "lichess"});
            
            this.dbGameIds.set(lichessGameId, game.id);

            // Fetch any existing moves if resuming
            const moves = await dbClient.getGameMoves(game.id);
            this.savedPlies.set(lichessGameId, moves.length);
        } catch (error) {
            console.error(`[${lichessGameId}] Failed to create/resume DB game:`, error.message);
        }
    }

    async saveNewMoves(lichessGameId, movesString) {
        const dbGameId = this.dbGameIds.get(lichessGameId);
        if (dbGameId == null) return;

        const allMoves = movesString.trim() === "" ? [] : movesString.trim().split(" ");
        const savedPliesCount = this.savedPlies.get(lichessGameId) ?? 0;
        const newMoves = allMoves.slice(savedPliesCount);
        if (newMoves.length === 0) return;

        try {
            await dbClient.insertGameMoves(dbGameId, newMoves.map((uci, i) => ({
                ply: savedPliesCount + i + 1,
                uci,
            })));
            this.savedPlies.set(lichessGameId, allMoves.length);
        } catch (error) {
            console.error(`[${lichessGameId}] Failed to save moves:`, error.message);
        }
    }

    async finalizeDbGame(lichessGameId, status, winner) {
        const dbGameId = this.dbGameIds.get(lichessGameId);
        if (dbGameId == null) return;

        try {
            await dbClient.updateGame(dbGameId, {
                result: mapResult(status, winner),
                termination: status,
                finished_at: new Date().toISOString(),
            });
        } catch (error) {
            console.error(`[${lichessGameId}] Failed to finalize DB game:`, error.message);
        }

        this.dbGameIds.delete(lichessGameId);
        this.savedPlies.delete(lichessGameId);
    }

    async createChallenge(username, limit, increment, rated = true) {
        await this._throttleGlobalChallenge();
        console.log(`Challenging ${username} (${limit}+${increment}, ${rated ? "rated" : "casual"})...`);
        const body = new URLSearchParams({
            "clock.limit": limit,
            "clock.increment": increment,
            rated: rated ? "true" : "false",
        });
        const res = await this._lichessFetch(`https://lichess.org/api/challenge/${username}`, {
            method: "POST",
            headers: this.formHeaders,
            body,
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    }

    async createOpenChallenge(limit, increment, rated = true) {
        await this._throttleGlobalChallenge();
        console.log(`Creating open challenge (${limit}+${increment}, ${rated ? "rated" : "casual"})...`);
        const body = new URLSearchParams({
            "clock.limit": limit,
            "clock.increment": increment,
            rated: rated ? "true" : "false",
        });
        const res = await this._lichessFetch("https://lichess.org/api/challenge/open", {
            method: "POST",
            headers: this.formHeaders,
            body,
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    }

    async createAiChallenge(level, limit, increment) {
        await this._throttleGlobalChallenge();
        console.log(`Challenging Stockfish level ${level}...`);
        const body = new URLSearchParams({
            level,
            "clock.limit": limit,
            "clock.increment": increment,
        });
        const res = await this._lichessFetch("https://lichess.org/api/challenge/ai", {
            method: "POST",
            headers: this.formHeaders,
            body,
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    }

    async cancelChallenge(challengeId) {
        await this._throttleGlobalChallenge();
        await this._lichessFetch(`https://lichess.org/api/challenge/${challengeId}/cancel`, {
            method: "POST",
            headers: this.authHeader,
        }).catch(() => {});
    }

    _pruneDeclined() {
        const now = this._now();
        for (const [name, expiresAt] of this.recentlyDeclined) {
            if (expiresAt <= now) this.recentlyDeclined.delete(name);
        }
    }

    _inDeclineCooldown(username) {
        const expiresAt = this.recentlyDeclined.get(username.toLowerCase());
        return expiresAt != null && expiresAt > this._now();
    }

    _markDeclined(username) {
        this.recentlyDeclined.set(username.toLowerCase(), this._now() + this.declineCooldownMs);
    }

    _isRateLimited() {
        return this.rateLimitedUntil > this._now();
    }

    _rateLimitRemainingSec() {
        const ms = this.rateLimitedUntil - this._now();
        return ms > 0 ? Math.ceil(ms / 1000) : 0;
    }

    _setRateLimit(retryAfterSec) {
        // Apply an exponential multiplier based on how many consecutive 429s we've taken.
        this.rateLimitConsecutiveHits++;
        const exp = Math.min(this.rateLimitConsecutiveHits - 1, 10);
        const multiplier = Math.min(Math.pow(2, exp), this.rateLimitMaxMultiplier);
        const totalSec = Math.ceil(retryAfterSec * multiplier);
        const candidate = this._now() + totalSec * 1000;

        if (candidate > this.rateLimitedUntil) this.rateLimitedUntil = candidate;

        if (multiplier > 1) {
            console.warn(`[Hunt] Consecutive 429 #${this.rateLimitConsecutiveHits}; backing off ${totalSec}s (${multiplier}× Retry-After)`);
        }

        this._saveRateLimitState().catch(() => {});
    }

    _onSuccessfulPost() {
        // A successful challenge POST proves our rate-limit credit is restored.
        if (this.rateLimitConsecutiveHits > 0) {
            console.log(`[Hunt] Rate-limit recovered after ${this.rateLimitConsecutiveHits} consecutive hit(s).`);
            this.notifier.info("[Autoplay] Autoplay restarted after rate limit", {hits: this.rateLimitConsecutiveHits});
            this.rateLimitConsecutiveHits = 0;
            this._saveRateLimitState().catch(() => {});
        }
    }

    // Issue one challenge POST. Resolves to {id, target} on success, null on
    // a 4xx decline (also marks the target). Throws LichessRateLimited on 429
    // so callers can short-circuit the whole fan-out.
    async _postOneChallenge(target, limit, increment, rated) {
        const body = new URLSearchParams({
            "clock.limit": limit,
            "clock.increment": increment,
            rated: rated ? "true" : "false",
        });
        let cRes;
        try {
            cRes = await this._lichessFetch(`https://lichess.org/api/challenge/${target.username}`, {
                method: "POST",
                headers: this.formHeaders,
                body,
            });
        } catch (err) {
            if (err instanceof LichessRateLimited) throw err;
            console.warn(`[Hunt] Challenge to ${target.username} threw: ${err?.message}`);
            this._markDeclined(target.username);
            return null;
        }


        if (!cRes.ok) {
            // Defensive: some mocks (and edge-case responses) omit text(). Don't
            // let a missing method cause us to skip the _markDeclined() call.
            let detail = "";
            try { detail = typeof cRes.text === "function" ? await cRes.text() : ""; }
            catch (_) {}
            console.warn(`[Hunt] ${target.username}: HTTP ${cRes.status ?? "?"} ${String(detail).slice(0, 200)}`);
            this._markDeclined(target.username);
            return null;
        }
        const {id} = await cRes.json();
        this._onSuccessfulPost();
        return {id, target};
    }

    // Challenge candidates sequentially, waiting up to huntAcceptTimeoutMs for
    // each to accept. Ensures at most one challenge is active/pending at a time
    // to avoid rate limits. Staggers consecutive challenges by challengeSpacingMs.
    // Returns the winning {id, target} or null if nobody accepted. Cancels
    // any non-winners and marks them declined. Throws LichessRateLimited on first 429.
    async _raceChallenges(candidates, limit, increment, rated) {
        const challengedCandidates = [];
        let winner = null;

        try {
            for (const target of candidates) {
                if (this._isRateLimited()) {
                    throw new LichessRateLimited(this._rateLimitRemainingSec());
                }

                let acceptedChallenge = null;
                try {
                    await this._throttleGlobalChallenge();
                    acceptedChallenge = await this._postOneChallenge(target, limit, increment, rated);
                } catch (err) {
                    if (err instanceof LichessRateLimited) {
                        throw err;
                    }
                    console.warn(`[Hunt] Challenge to ${target.username} threw: ${err?.message}`);
                    continue;
                }

                if (!acceptedChallenge) {
                    continue;
                }

                challengedCandidates.push(acceptedChallenge);

                // Wait up to huntAcceptTimeoutMs for this specific challenge to be accepted
                const deadline = this._now() + this.huntAcceptTimeoutMs;
                let accepted = false;
                while (this._now() < deadline) {
                    await new Promise(r => setTimeout(r, this.huntPollIntervalMs));
                    if (this.activeGames.has(acceptedChallenge.id)) {
                        accepted = true;
                        break;
                    }
                }

                if (accepted) {
                    winner = acceptedChallenge;
                    break;
                } else {
                    // Timeout for this candidate. Cancel the challenge so we can try the next one.
                    await this.cancelChallenge(acceptedChallenge.id);
                }
            }
        } catch (err) {
            // Cancel all challenges that were created during this hunt
            await Promise.allSettled(challengedCandidates.map(({id}) => this.cancelChallenge(id)));
            throw err;
        }

        // If there was no winner, mark all challenged candidates as declined
        if (!winner) {
            for (const {target} of challengedCandidates) {
                this._markDeclined(target.username);
            }
        }

        return winner;
    }

    // Pick a Lichess perf name (bullet/blitz/rapid/classical) from a time control.
    // Uses Lichess's own classification: estimated = initialSec + 40 * incSec.
    _performanceFromTimeControl(limitSec, incrementSec) {
        const estimatedSeconds = limitSec + 40 * incrementSec;
        if (estimatedSeconds < 180) return "bullet";
        if (estimatedSeconds < 480) return "blitz";
        if (estimatedSeconds < 1500) return "rapid";
        return "classical";
    }

    async _fetchMyRating(perf) {
        if (!this._profileCache || this._now() - this._profileCache.time > 60000) {
            const res = await this._lichessFetch("https://lichess.org/api/account", {headers: this.authHeader});
            if (!res.ok) throw new Error("Failed to fetch own profile");
            this._profileCache = { data: await res.json(), time: this._now() };
        }
        const profile = this._profileCache.data;
        const rating = profile.perfs?.[perf]?.rating;
        if (rating == null) throw new Error(`No ${perf} rating on profile yet`);
        return {rating, prov: !!profile.perfs[perf].prov};
    }

    // Challenge bots within ±window of our own rating for the given TC. Tries
    // up to `maxAttempts` candidates, ordered by closeness in rating; returns
    // the first one that accepts within ~5s.
    async huntNearRating(limit, increment, rated = true, {window = 200, maxAttempts = 1, poolSize = 80, maxWindow = 2000} = {}) {
        if (this._isRateLimited()) {
            throw new LichessRateLimited(this._rateLimitRemainingSec());
        }
        const perf = this._performanceFromTimeControl(limit, increment);
        const {rating: myRating, prov} = await this._fetchMyRating(perf);
        console.log(`[Hunt] My ${perf} rating: ${myRating}${prov ? " (provisional)" : ""}; window ±${window} (max ±${maxWindow})`);

        const bots = await this._fetchOnlineBots(500);

        this._pruneDeclined();

        // Pre-compute deltas for every rated, non-self bot so we can re-filter
        // by window cheaply across widening attempts.
        const ratedBots = bots
            .filter(b => b.id !== this.botProfile?.toLowerCase())
            .filter(b => b.perfs?.[perf]?.rating != null)
            .map(b => ({...b, _delta: Math.abs(b.perfs[perf].rating - myRating)}));

        // Auto-widen: grow the window until the cool-down-filtered pool has
        // at least one candidate or we hit maxWindow. Without this we get
        // stuck for the whole cool-down period when every near-rating bot is
        // either offline or marked declined.
        let currentWindow = Math.max(0, Math.min(window, maxWindow));
        let pool = [];
        let filteredOut = 0;
        const widenedFrom = currentWindow;

        while (true) {
            const inWindow = ratedBots.filter(b => b._delta <= currentWindow);
            filteredOut = inWindow.filter(b => this._inDeclineCooldown(b.username)).length;
            pool = inWindow
                .filter(b => !this._inDeclineCooldown(b.username))
                .sort((a, b) => a._delta - b._delta)
                .slice(0, poolSize);

            if (pool.length > 0) break;
            if (currentWindow >= maxWindow) break;

            const next = Math.min(currentWindow * 2 || 1, maxWindow);
            console.log(`[Hunt] Empty pool at ±${currentWindow} (${inWindow.length} eligible, ${filteredOut} in cool-down) — widening to ±${next}`);
            currentWindow = next;
        }

        if (filteredOut > 0) {
            console.log(`[Hunt] Skipped ${filteredOut} bot(s) in decline cool-down (active: ${this.recentlyDeclined.size})`);
        }

        // Fisher-Yates shuffle.
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const candidates = pool.slice(0, maxAttempts);

        if (candidates.length === 0) {
            const reason = filteredOut > 0
                ? `all ${filteredOut} bot(s) within ±${currentWindow} in cool-down`
                : `none within ±${currentWindow} of ${perf}=${myRating}`;
            throw new Error(`No challengeable bots — ${reason} (saw ${bots.length} online)`);
        }

        const widenedNote = currentWindow !== widenedFrom ? ` (widened ±${widenedFrom}→±${currentWindow})` : "";
        console.log(`[Hunt] ${candidates.length} candidates from pool of ${pool.length}${widenedNote}; challenging sequentially`);
        for (const c of candidates) {
            console.log(`[Hunt]   ${c.username} (${perf}=${c.perfs[perf].rating}, Δ${c._delta})`);
        }

        const winner = await this._raceChallenges(candidates, limit, increment, rated);
        if (winner) {
            const r = winner.target.perfs[perf].rating;
            return {status: "success", message: `Playing vs ${winner.target.username} (${r})`, gameId: winner.id, myRating, targetRating: r};
        }

        throw new Error(`Hunt failed — none of ${candidates.length} near-rating bots accepted`);
    }

    async huntWeakestBot(limit, increment, rated = true) {
        if (this._isRateLimited()) {
            throw new LichessRateLimited(this._rateLimitRemainingSec());
        }
        console.log(`Hunting weakest bot (${limit}+${increment}, ${rated ? "rated" : "casual"})...`);

        const bots = await this._fetchOnlineBots(500);

        this._pruneDeclined();

        const eligible = bots
            .filter(b => b.id !== this.botProfile?.toLowerCase())
            .filter(b => b.perfs?.blitz?.rating != null);

        const filteredOut = eligible.filter(b => this._inDeclineCooldown(b.username)).length;
        const candidates = eligible
            .filter(b => !this._inDeclineCooldown(b.username))
            .sort((a, b) => a.perfs.blitz.rating - b.perfs.blitz.rating)
            .slice(0, 2);

        if (filteredOut > 0) {
            console.log(`[Hunt] Skipped ${filteredOut} bot(s) in decline cool-down`);
        }

        if (candidates.length === 0) throw new Error("No candidates found");

        console.log(`[Hunt] ${candidates.length} weakest candidates; challenging sequentially`);
        const winner = await this._raceChallenges(candidates, limit, increment, rated);
        if (winner) {
            return {status: "success", message: `Playing vs ${winner.target.username}`, gameId: winner.id};
        }

        throw new Error("Hunt failed — all candidates ignored our challenges.");
    }

    async _throttleGlobalChallenge() {
        const now = this._now();
        const elapsedSinceLast = now - this.lastChallengeTime;
        if (this.lastChallengeTime > 0 && elapsedSinceLast < this.challengeSpacingMs) {
            await new Promise(r => setTimeout(r, this.challengeSpacingMs - elapsedSinceLast));
        }
        this.lastChallengeTime = this._now();
    }

    async _lichessFetch(url, options = {}) {
        if (this._isRateLimited()) {
            throw new LichessRateLimited(this._rateLimitRemainingSec());
        }

        const now = this._now();
        const elapsed = now - (this.lastApiTime || 0);
        if (this.lastApiTime && elapsed < this.apiSpacingMs) {
            await new Promise(r => setTimeout(r, this.apiSpacingMs - elapsed));
        }
        this.lastApiTime = this._now();

        // Add a 15-second timeout to prevent indefinite hangs if Cloudflare/Lichess drops packets
        const timeoutMs = options.timeoutMs ?? 15000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(new Error("Lichess timeout")), timeoutMs);
        
        // Merge with existing signal if any
        if (options.signal) {
            options.signal.addEventListener("abort", () => controller.abort(options.signal.reason), {once: true});
        }

        let res;
        try {
            res = await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }

        if (res.status === 429) {
            let body = "";
            try { body = await res.text(); } catch (e) {}
            console.error(`[Lichess API] 429 Rate Limited. Response body: ${body}`);
            const retryAfter = parseInt(res.headers?.get?.("Retry-After") ?? "", 10);
            const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : this.defaultRetryAfterSec;
            this._setRateLimit(seconds);
            throw new LichessRateLimited(this._rateLimitRemainingSec() || seconds);
        }
        return res;
    }

    async _fetchOnlineBots(limit) {
        if (!this._onlineBotsCache || this._now() - this._onlineBotsCache.time > 30000) {
            const res = await this._lichessFetch(`https://lichess.org/api/bot/online?nb=${limit}`, {
                headers: {Accept: "application/x-ndjson"},
            });
            if (!res.ok) throw new Error("Failed to fetch online bots");
            const bots = [];
            await this.readNdjsonStream(res.body, null, (bot) => { bots.push(bot); });
            this._onlineBotsCache = { data: bots, time: this._now() };
        }
        return this._onlineBotsCache.data;
    }

    async readNdjsonStream(readableStream, signal, callback) {
        const reader = readableStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const onAbort = () => reader.cancel().catch(() => {});
        signal?.addEventListener("abort", onAbort, {once: true});

        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, {stream: true});
                const lines = buffer.split("\n");
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        await callback(JSON.parse(line));
                    } catch (e) {
                        console.error("[NDJSON] Callback error:", e);
                    }
                }
            }
        } finally {
            signal?.removeEventListener("abort", onAbort);
            reader.releaseLock();
        }
    }
}

export function extractTime(state) {
    if (!state) return {};
    return {
        wtime: state.wtime,
        btime: state.btime,
        winc: state.winc,
        binc: state.binc,
    };
}
