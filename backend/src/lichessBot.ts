import {dbClient} from "./dbClient.js";
import {Notifier} from "./notifier.js";
import {nullNotifier} from "./notifier.js";
import {OPENINGS} from "./openings.js";
import {ApiTransport} from "./apiTransport.js";
import {LichessBotOptions, LichessAutoplayOptions, LichessAutoplayState, NotifierClass, EngineManagerClass, LichessFetchOptions} from "../../Shared/Types.ts";

export class LichessRateLimited extends Error {
    retryAfterSec: number
    isExplicit: boolean
    bodyText: string

    constructor(retryAfterSec, isExplicit = false) {
        super(`Lichess rate-limited; retry after ${retryAfterSec}s`);
        this.name = "LichessRateLimited";
        this.retryAfterSec = retryAfterSec;
        this.isExplicit = isExplicit;
    }

    static async fromResponse(response, defaultRetryAfterSec = 150) {
        let body = "";
        let parsedBody = null;
        try {
            body = await response.text();
            parsedBody = JSON.parse(body);
        } catch (e) {
        }
        
        let retryAfter = parseInt(response.headers?.get?.("Retry-After") ?? "", 10);
        if (!Number.isFinite(retryAfter) || retryAfter <= 0) {
            if (parsedBody && parsedBody.ratelimit && typeof parsedBody.ratelimit.seconds === "number") {
                retryAfter = parsedBody.ratelimit.seconds;
            }
        }
        
        const isExplicit = Number.isFinite(retryAfter) && retryAfter > 0;
        const seconds = isExplicit ? retryAfter : defaultRetryAfterSec;
        
        const errorMsg = parsedBody?.error?.toLowerCase() || body.toLowerCase();
        
        const isBotLimit = (errorMsg.includes("bot") && errorMsg.includes("limit")) || 
                           (errorMsg.includes("bot") && errorMsg.includes("games"));
        
        const error = isBotLimit
            ? new LichessMaxBotGamesReached(seconds, isExplicit)
            : new LichessRateLimited(seconds, isExplicit);
        
        error.bodyText = body;
        return error;
    }
}

export class LichessMaxBotGamesReached extends LichessRateLimited {
    constructor(retryAfterSec, isExplicit = false) {
        super(retryAfterSec, isExplicit);
        this.name = "LichessMaxBotGamesReached";
        this.message = `Lichess max bot games limit reached; retry after ${retryAfterSec}s`;
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
    if (winner === "white") return "1-0";
    if (winner === "black") return "0-1";
    if (["draw", "stalemate", "threefoldRepetition", "insufficient", "fiftyMoves", "outoftime", "timeout"].includes(status)) return "1/2-1/2";
    return null;
}

export class LichessBot {
    // Always resolved in the constructor (option ?? default, or a fresh value).
    private token: string
    private engineFactory: () => EngineManagerClass
    maxConcurrentGames: number
    huntPollIntervalMs: number
    reconnectDelayMs: number
    notifier: NotifierClass
    declineCooldownMs: number
    _now: () => number
    recentlyDeclined: Map<string, number>
    huntAcceptTimeoutMs: number
    defaultRetryAfterSec: number
    rateLimitedUntil: number
    maxBotGamesUntil: number
    apiTransport: ApiTransport
    authHeader: Record<string, string>
    formHeaders: Record<string, string>
    activeGames: Set<string>
    gameControllers: Map<string, AbortController>
    gameEngines: Map<string, EngineManagerClass>
    dbGameIds: Map<string, number>
    savedPlies: Map<string, number>
    gameOpenings: Map<string, any>
    joinedTournaments: Set<string>
    tournaments: Map<string, any>

    // Always present, but null is a real state until set later.
    botProfile: string | null
    eventController: AbortController | null
    autoplay: LichessAutoplayState | null

    // Lazily populated — genuinely absent until first use.
    _profileCache?: {data: any; time: number}
    _onlineBotsCache?: {data: any[]; time: number}

    constructor(token, engineFactory, options: LichessBotOptions = {}) {
        this.token = token;
        this.engineFactory = engineFactory;
        this.maxConcurrentGames = options.maxConcurrentGames ?? 5;
        this.huntPollIntervalMs = options.huntPollIntervalMs ?? 1000;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
        this.notifier = options.notifier ?? new Notifier() ?? nullNotifier;

        // Cool-down for bots that ignored our challenges. We keep a map of username -> expiresAt so the pool builder can skip them on the next hunt.
        this.declineCooldownMs = options.declineCooldownMs ?? 15 * 60 * 1000;
        this._now = options.now || (() => Date.now());
        this.recentlyDeclined = new Map();

        // How long to wait, after all candidates are posted, for any of them to accept before giving up on the whole pool.
        this.huntAcceptTimeoutMs = options.huntAcceptTimeoutMs ?? 5000;
        // Fallback retry-after when Lichess sends a 429 without a Retry-After
        // header. Kept conservative so we don't immediately re-trigger.
        this.defaultRetryAfterSec = options.defaultRetryAfterSec ?? 150;

        // Global rate-limit gate. Set only by a true API 429 ("too many
        // requests"). Every request path honours it, since the whole account is
        // throttled until its Retry-After expires.
        this.rateLimitedUntil = 0;

        // Daily bot-games cap gate. Set only by LichessMaxBotGamesReached. This
        // blocks bot challenges/hunts but NOT human tournament play, so only the
        // bot-hunting paths consult it — tournament fetch/join ignore it.
        this.maxBotGamesUntil = 0;

        this.apiTransport = options.apiTransport ?? new ApiTransport({
            token: this.token,
            notifier: this.notifier
        });

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

        // FIXME: why do we need these? why hold everything in memory?
        this.dbGameIds = new Map();
        this.savedPlies = new Map();
        this.gameOpenings = new Map();
        this.joinedTournaments = new Set();
        // Everything we've discovered (arena + swiss across the bot's teams),
        // keyed by id, surfaced to the frontend via the lichess status.
        this.tournaments = new Map();

        // Autoplay: when enabled, the bot fills free slots via huntWeakestBot.
        this.autoplay = null; // {limit, increment, rated, target, ...openings, timer, huntInFlight}
    }

    startAutoplay({limit = 180, increment = 2, rated = true, target = 3, mode = "near", window = 200, whiteOpeningId = null, blackOpeningId = null, opponentType = "both"}: LichessAutoplayOptions = {}) {
        this.stopAutoplay();

        // target = how many active games we'd like to keep going at once.
        // Capped by maxConcurrentGames as a safety.
        const cappedTarget = Math.min(target, this.maxConcurrentGames);

        this.autoplay = {limit, increment, rated, target: cappedTarget, mode, window, whiteOpeningId, blackOpeningId, opponentType, timer: null, huntInFlight: false};

        this.notifier.info("[Autoplay] Autoplay enabled", {limit, increment, rated, target: cappedTarget, mode, window, whiteOpeningId, blackOpeningId, opponentType});

        const whiteString = whiteOpeningId ? `white=${whiteOpeningId}` : "";
        const blackString = blackOpeningId ? `${whiteString ? ", " : ""}black=${blackOpeningId}` : "";
        const optionsString = whiteString || blackString ? `, ${whiteString}${blackString}` : "";

        this.notifier.info(`[Autoplay] Enabled (${limit}+${increment} ${rated ? "rated" : "casual"}, target=${cappedTarget}, mode=${mode}${mode === "near" ? `, window=±${window}` : ""}, opponentType=${opponentType}${optionsString})`);
        this._tickAutoplay();
    }

    stopAutoplay() {
        if (!this.autoplay) return;

        // Cancel the pending tick so a stale timer can't fire after we stop.
        if (this.autoplay.timer) clearTimeout(this.autoplay.timer);

        this.autoplay = null;
        this.notifier.info("[Autoplay] Disabled");
    }

    autoplayStatus() {
        if (!this.autoplay) return {enabled: false};
        const {limit, increment, rated, target, mode, window, whiteOpeningId, blackOpeningId, opponentType, huntInFlight} = this.autoplay;
        return {enabled: true, limit, increment, rated, target, mode, window, whiteOpeningId, blackOpeningId, opponentType, huntInFlight, active: this.activeGames.size};
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

        const playBots = this.autoplay.opponentType === "bots" || this.autoplay.opponentType === "both";
        const playHumans = this.autoplay.opponentType === "humans" || this.autoplay.opponentType === "both";

        // A true API rate-limit throttles every request — even tournament joins —
        // so honour it without firing any hunt at all.
        if (this._isRateLimited()) {
            const remainingSec = this._rateLimitRemainingSec();
            const waitMs = remainingSec * 1000 + 500;
            this.notifier.warn("[Autoplay] Rate-limited; skipping tick", {remainingSec, waitMs});
            this.autoplay.timer = setTimeout(() => this._tickAutoplay(), waitMs);
            return;
        }

        this.autoplay.huntInFlight = true;

        const {limit, increment, rated, mode, window} = this.autoplay;

        const totalSlots = Math.max(1, this.autoplay.target - this.activeGames.size);

        // Direct bot challenges are blocked once we hit the daily bot-games cap.
        // Tournament play is NOT (lila only enforces the cap on the challenge
        // path), so it keeps producing bot games and serves as the fallback.
        const botCapped = this._isMaxBotGamesReached();
        if (botCapped && playBots) {
            this.notifier.info("[Autoplay] Bot challenges capped for the day; relying on tournament play");
        }

        const botSlots = !playBots || botCapped ? 0
            : !playHumans ? totalSlots
            : Math.ceil(totalSlots / 2);

        let huntPromise: Promise<unknown> = Promise.resolve();

        if (botSlots > 0) {
            huntPromise = mode === "weakest"
                ? this.huntWeakestBot(limit, increment, rated, botSlots)
                : this.huntNearRating(limit, increment, rated, {window, count: botSlots});
        }

        huntPromise
        .catch(err => {
            // A 429 has already set rateLimitedUntil (via _lichessFetch), so the
            // reschedule below honours it. Any other failure (e.g. no candidate
            // bots) just means "try again on the next tick".
            if (err instanceof LichessMaxBotGamesReached) {
                this.notifier.warn("[Hunt] Max bot games reached", {retryAfterSec: err.retryAfterSec});
            } else if (err instanceof LichessRateLimited) {
                this.notifier.warn("[Hunt] Lichess rate limit", {retryAfterSec: err.retryAfterSec});
            } else {
                this.notifier.info(`[Autoplay] Hunt bots failed (${err.message}); retrying`);
            }
        })
        .finally(async () => {
            if (!this.autoplay) return;

            // Fill whatever direct challenges couldn't with tournament play. This
            // runs even when bot-capped — it's the only way to keep playing bots
            // past the cap — so it's gated on wanting any games at all, not on
            // bot-cap state.
            const openSlots = Math.max(0, this.autoplay.target - this.activeGames.size);
            if (openSlots > 0 && (playBots || playHumans)) {
                try {
                    await this.huntTournaments(openSlots);
                } catch (err) {
                    this.notifier.info(`[Autoplay] Hunt tournaments failed (${err.message})`);
                }
            }

            if (!this.autoplay) return;
            this.autoplay.huntInFlight = false;

            // While bot-capped, direct challenges are dead weight — poll a bit
            // slower so we don't hammer the team/arena endpoints for hours, but
            // still often enough to catch newly-started tournaments.
            const wait = this._isMaxBotGamesReached() ? 60_000 : 10_000;
            this.autoplay.timer = setTimeout(() => this._tickAutoplay(), wait);
        });
    }

    async _loadRateLimitState() {
        if (process.env.NODE_ENV === "test") return;

        try {
            const file = Bun.file("lichess-rate-limit.json");
            if (await file.exists()) {
                const data = await file.json();

                // Files written before the bot-cap/rate-limit split only carry
                // `rateLimitedUntil`. In practice that long window was always the
                // daily bot-games cap, so migrate it there — otherwise it would
                // wrongly keep blocking human tournament hunting after a restart.
                if (data.maxBotGamesUntil === undefined) {
                    if (data.rateLimitedUntil && data.rateLimitedUntil > this._now()) {
                        this.maxBotGamesUntil = data.rateLimitedUntil;
                        const remainingSec = Math.ceil((this.maxBotGamesUntil - this._now()) / 1000);
                        this.notifier.info(`[Bot] Migrated legacy rate-limit state to bot-games cap: ${remainingSec}s`);
                        await this._saveRateLimitState().catch(() => {});
                    }
                    return;
                }

                if (data.rateLimitedUntil && data.rateLimitedUntil > this._now()) {
                    // Survive a restart mid-ban so we don't immediately fire a
                    // fresh request and eat another 429.
                    this.rateLimitedUntil = data.rateLimitedUntil;
                    const remainingSec = Math.ceil((this.rateLimitedUntil - this._now()) / 1000);
                    this.notifier.info(`[Bot] Restored rate limit state from disk: rate-limited for ${remainingSec}s`);
                }
                if (data.maxBotGamesUntil && data.maxBotGamesUntil > this._now()) {
                    this.maxBotGamesUntil = data.maxBotGamesUntil;
                    const remainingSec = Math.ceil((this.maxBotGamesUntil - this._now()) / 1000);
                    this.notifier.info(`[Bot] Restored bot-games cap from disk: ${remainingSec}s`);
                }
            }
        } catch (err) {
            this.notifier.error("[Bot] Failed to load rate limit state:", err);
        }
    }

    async _saveRateLimitState() {
        if (process.env.NODE_ENV === "test") return;
        try {
            const data = {rateLimitedUntil: this.rateLimitedUntil, maxBotGamesUntil: this.maxBotGamesUntil};
            await Bun.write("lichess-rate-limit.json", JSON.stringify(data));
        } catch (err) {
            this.notifier.error("[Bot] Failed to save rate limit state:", err);
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
                this.notifier.info(`[Bot] Logged in as: ${this.botProfile} (max ${this.maxConcurrentGames} concurrent games)`);
                return true;
            }
        } catch (_) {
        }
        return false;
    }

    async start() {
        this.notifier.info("[Bot] Starting...");
        await this._loadRateLimitState().catch(() => {
        });

        if (this._isRateLimited()) {
            this.botProfile = null;
            const waitSec = this._rateLimitRemainingSec();
            this.notifier.warn(`[Bot] Restored rate limit state from disk. Starting in rate-limited state for ${waitSec}s.`);
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
            this.notifier.info(`[Bot] Logged in as: ${this.botProfile} (max ${this.maxConcurrentGames} concurrent games)`);
        } catch (err) {
            if (err instanceof LichessRateLimited) {
                this.botProfile = null;
                this.notifier.warn(`[Bot] Started in rate-limited state. Will resolve profile in background.`);
            } else {
                throw err;
            }
        }

        this.streamEvents();

        // Clean up any games orphaned by a previous ungraceful shutdown, in the
        // background so it never delays startup.
        this.reconcileUnfinishedGames().catch(err => this.notifier.warn(`[Reconcile] Failed: ${err?.message}`));
    }

    stop() {
        this.notifier.info("[Bot] Stopping...");
        this.stopAutoplay();

        if (this.eventController) {
            this.eventController.abort();
            this.eventController = null;
        }

        for (const [gameId, controller] of this.gameControllers) {
            controller.abort();
            this.notifier.info(`[${gameId}] Stream aborted.`);
        }
        this.gameControllers.clear();

        for (const [gameId, engine] of this.gameEngines) {
            engine.stop().catch(err => this.notifier.error(`[${gameId}] Engine stop error:`, err));
        }
        this.gameEngines.clear();

        this.activeGames.clear();
        this.dbGameIds.clear();
        this.savedPlies.clear();

        this.notifier.info("[Bot] Stopped.");
    }

    async streamEvents() {
        this.eventController = new AbortController();
       this.notifier.info("[Bot] Listening for events...");

        try {
            const res = await this._lichessFetch("https://lichess.org/api/stream/event", {
                headers: this.authHeader,
                signal: this.eventController.signal,
            });

            if (!res.ok) {
                this.notifier.error("[Bot] Event stream failed:", res.statusText);
                setTimeout(() => this.streamEvents(), this.reconnectDelayMs);
                return;
            }

            // Attempt to resolve profile since the event stream connected successfully
            if (!this.botProfile) {
                this._ensureProfile().catch(() => {
                });
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
                this.notifier.info("[Bot] Event stream cancelled.");
                return;
            }
            this.notifier.error("[Bot] Event stream error:", err);
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
            this.notifier.info(`[Challenge ${challenge.id}] Declining — unsupported variant: ${variant}`);
            await this.declineChallenge(challenge.id, "variant");
            return;
        }

        if (this.activeGames.size >= this.maxConcurrentGames) {
            this.notifier.info(`[Challenge ${challenge.id}] Declining — at max concurrent games (${this.maxConcurrentGames})`);
            this.notifier.info(`[Challenge] Declining challenge ${challenge.id}`, {reason: "at_cap", active: this.activeGames.size});
            await this.declineChallenge(challenge.id, "later");
            return;
        }

        this.notifier.info(`[Challenge ${challenge.id}] Accepting`);
        await this._lichessFetch(`https://lichess.org/api/challenge/${challenge.id}/accept`, {
            method: "POST",
            headers: this.authHeader,
        });
    }

    async declineChallenge(challengeId, reason = "generic") {
        const body = new URLSearchParams({reason});
        await this._lichessFetch(`https://lichess.org/api/challenge/${challengeId}/decline`, {
            method: "POST",
            headers: this.formHeaders,
            body,
        }).catch(() => {
        });
    }

    async playGame(gameId) {
        if (this.activeGames.has(gameId)) return;
        this.activeGames.add(gameId);

        this.notifier.info(`[${gameId}] Game started.`);
        this.notifier.info(`[Game] Game started: ${gameId}`, {active: this.activeGames.size, max: this.maxConcurrentGames});

        await this._ensureProfile().catch(() => {
        });

        const gameController = new AbortController();
        this.gameControllers.set(gameId, gameController);

        let engine: EngineManagerClass;

        try {
            engine = this.engineFactory();
        } catch (err) {
            // EngineCapReached or any factory failure: don't try to play. Resign and bail.
            // Existing in-flight games keep running — we just don't add another.
            this.notifier.error(`[${gameId}] Engine factory rejected:`, err);
            this.notifier.warn(`[Game] Refused to spawn engine for ${gameId}`, {message: err?.message});
            try {
                await this.resignGame(gameId);
            } catch (_) {
            }
            this.activeGames.delete(gameId);
            this.gameControllers.delete(gameId);
            return;
        }
        this.gameEngines.set(gameId, engine);

        engine.on("fatal_error", async (err) => {
            this.notifier.error(`[${gameId}] !! ENGINE FATAL ERROR !! Resigning game.`, err);
            this.notifier.error(`[Game] Engine fatal in game ${gameId}`, {message: err?.message});
            try {
                await this.resignGame(gameId);
            } catch (_) {
            }
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
                this.notifier.error(`[${gameId}] !! ENGINE START FAILED !! Resigning game.`, startErr);
                try {
                    await this.resignGame(gameId);
                } catch (_) {
                }
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
                    this.notifier.info(`[${gameId}] Game over: ${status}, winner: ${winner ?? "draw"}`);
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
                            this.notifier.error(`[${gameId}] Engine stuck (${consecutiveMoveFailures} consecutive move failures) — resigning.`);
                            this.notifier.warn(`[Game] Engine stuck in ${gameId}, resigning`, {failures: consecutiveMoveFailures});
                            try {
                                await this.resignGame(gameId);
                            } catch (_) {
                            }
                            gameController.abort();
                            return;
                        }
                    }
                }
            });

        } catch (err) {
            if (err.name !== "AbortError") {
                this.notifier.error(`[${gameId}] Game stream error:`, err);
            }
        } finally {
            try {
                await engine.stop();
            } catch (e) {
                this.notifier.error(`[${gameId}] Engine stop error:`, e);
            }
            this.gameEngines.delete(gameId);
            this.activeGames.delete(gameId);
            this.gameOpenings.delete(gameId);
            this.gameControllers.delete(gameId);
            this.notifier.info(`[${gameId}] Cleaned up.`);
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
        this.notifier.info(`[${gameId}] My turn (${myColor}).`);

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
            this.notifier.info(`[${gameId}] Selected opening: ${currentOpeningId} for ${myColor}`);
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
                this.notifier.info(`[${gameId}] Forcing specific opening move: ${nextMove}`);
                return await this.sendMove(gameId, nextMove);
            }
        }

        try {
            await engine.position(initialFen, movesArray);
        } catch (err) {
            this.notifier.warn(`[${gameId}] position command failed: ${err.message}`);
            return false;
        }

        let rawMove;

        try {
            ({bestMove: rawMove} = await engine.go({
                depth: 0,
                nodes: 0,
                moveTime: 0,
                whiteTime: timeInfo.wtime,
                blackTime: timeInfo.btime,
                whiteIncrement: timeInfo.winc,
                blackIncrement: timeInfo.binc,
            }));
        } catch (err) {
            this.notifier.warn(`[${gameId}] go command failed: ${err.message}`);
            return false;
        }

        const bestMove = normalizeMove(rawMove);
        this.notifier.info(`[${gameId}] Engine: ${bestMove}`);

        if (!bestMove || bestMove === "(none)" || bestMove === "0000") {
            this.notifier.warn(`[${gameId}] No valid move — resigning.`);
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
                    this.notifier.warn(`[${gameId}] Move rejected (${move}): HTTP ${res.status} ${text}`);
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
                this.notifier.warn(`[${gameId}] Move API failed (${move}): ${err.message} (attempt ${attempt + 1}/${retries + 1})`);
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
        }).catch(() => {
        });
    }

    async createDbGame(lichessGameId, {whiteUsername, blackUsername, variant, rated, timeControl, whiteRating, blackRating}) {
        try {
            const game = await dbClient.createGame({lichessGameId, whiteUsername, blackUsername, variant, rated, timeControl, whiteRating, blackRating, env: process.env.APP_ENV || "prod", source: "lichess"});

            this.dbGameIds.set(lichessGameId, game.id);

            // Fetch any existing moves if resuming
            const moves = await dbClient.getGameMoves(game.id);
            this.savedPlies.set(lichessGameId, moves.length);
        } catch (error) {
            this.notifier.error(`[${lichessGameId}] Failed to create/resume DB game:`, error.message);
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
            this.notifier.error(`[${lichessGameId}] Failed to save moves:`, error.message);
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
            this.notifier.error(`[${lichessGameId}] Failed to finalize DB game:`, error.message);
        }

        this.dbGameIds.delete(lichessGameId);
        this.savedPlies.delete(lichessGameId);
    }

    // Games whose stream ended before a terminal state (e.g. an ungraceful
    // restart) are left with finished_at = null. Ask Lichess for their real
    // outcome and finalize them. Best-effort and rate-limit-aware.
    async reconcileUnfinishedGames() {
        if (process.env.NODE_ENV === "test") return;

        const myEnv = process.env.APP_ENV || "prod";

        let games;
        try {
            games = await dbClient.getRecentGames(200);
        } catch (err) {
            this.notifier.warn(`[Reconcile] Could not load recent games: ${err.message}`);
            return;
        }

        const activeDbIds = new Set(this.dbGameIds.values());
        const orphans = (games || []).filter(g =>
            g.source === "lichess" &&
            g.env === myEnv &&
            !g.finished_at &&
            g.lichess_game_id &&
            !activeDbIds.has(g.id)
        );
        if (orphans.length === 0) return;

        this.notifier.info(`[Reconcile] Checking ${orphans.length} unfinished game(s) against Lichess...`);
        let fixed = 0;

        for (const g of orphans) {
            try {
                const res = await this._lichessFetch(`https://lichess.org/game/export/${g.lichess_game_id}?moves=false&clocks=false`, {
                    headers: {Accept: "application/json"},
                });
                if (!res.ok) continue;

                const data = await res.json();
                const status = data.status;
                // Still in progress — leave it for the live stream to finalize.
                if (!status || status === "started" || status === "created") continue;

                await dbClient.updateGame(g.id, {
                    result: mapResult(status, data.winner),
                    termination: status,
                    finished_at: new Date().toISOString(),
                });
                fixed++;
            } catch (err) {
                if (err instanceof LichessRateLimited) {
                    this.notifier.warn("[Reconcile] Rate-limited; stopping for now");
                    break;
                }
                // Skip this game; reconciliation is best-effort.
            }
        }

        if (fixed > 0) this.notifier.info(`[Reconcile] Finalized ${fixed} orphaned game(s)`);
    }

    async createChallenge(username, limit, increment, rated = true) {
        this.notifier.info(`Challenging ${username} (${limit}+${increment}, ${rated ? "rated" : "casual"})...`);
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
        this.notifier.info(`Creating open challenge (${limit}+${increment}, ${rated ? "rated" : "casual"})...`);
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
        this.notifier.info(`Challenging Stockfish level ${level}...`);
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
        await this._lichessFetch(`https://lichess.org/api/challenge/${challengeId}/cancel`, {
            method: "POST",
            headers: this.authHeader,
        }).catch(() => {
        });
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

    _isMaxBotGamesReached() {
        return this.maxBotGamesUntil > this._now();
    }

    _maxBotGamesRemainingSec() {
        const ms = this.maxBotGamesUntil - this._now();
        return ms > 0 ? Math.ceil(ms / 1000) : 0;
    }

    // Guard for bot-hunting paths. Throws the matching error class so callers
    // log the right reason; the global limit takes precedence as it's stricter.
    _throwIfBotBlocked() {
        if (this._isRateLimited()) {
            throw new LichessRateLimited(this._rateLimitRemainingSec());
        }
        if (this._isMaxBotGamesReached()) {
            throw new LichessMaxBotGamesReached(this._maxBotGamesRemainingSec());
        }
    }

    // Honour Lichess's Retry-After for a true 429: hold off ALL requests until
    // the window expires.
    _setRateLimit(retryAfterSec) {
        const candidate = this._now() + retryAfterSec * 1000;
        if (candidate > this.rateLimitedUntil) this.rateLimitedUntil = candidate;
        this.notifier.warn(`[Lichess API] Rate-limited for ${retryAfterSec}s`);
        this._saveRateLimitState().catch(() => {
        });
    }

    // Honour the daily bot-games cap: hold off bot challenges/hunts until reset,
    // while leaving human tournament play available.
    _setMaxBotGamesLimit(retryAfterSec) {
        const candidate = this._now() + retryAfterSec * 1000;
        if (candidate > this.maxBotGamesUntil) this.maxBotGamesUntil = candidate;
        this.notifier.warn(`[Lichess API] Max bot games reached; bot challenges paused for ${retryAfterSec}s`);
        this._saveRateLimitState().catch(() => {
        });
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
            this.notifier.warn(`[Hunt] Challenge to ${target.username} threw: ${err?.message}`);
            this._markDeclined(target.username);
            return null;
        }


        if (!cRes.ok) {
            // Defensive: some mocks (and edge-case responses) omit text(). Don't
            // let a missing method cause us to skip the _markDeclined() call.
            let detail = "";
            try {
                detail = typeof cRes.text === "function" ? await cRes.text() : "";
            } catch (_) {
            }
            this.notifier.warn(`[Hunt] ${target.username}: HTTP ${cRes.status ?? "?"} ${String(detail).slice(0, 200)}`);
            this._markDeclined(target.username);
            return null;
        }
        const {id} = await cRes.json();
        return {id, target};
    }

    // Challenge candidates in order, waiting up to huntAcceptTimeoutMs for each to
    // accept, until `slots` games have started or we run out of candidates. Only
    // one challenge is pending at a time, so we never overshoot the open slots.
    // Returns an array of the winning {id, target} (0..slots). Cancels and
    // cool-downs candidates that ignored us; throws LichessRateLimited on the
    // first 429 (without penalising any bot, since a rate limit isn't their fault).
    async _raceChallenges(candidates, limit, increment, rated, slots = 1) {
        const pending = [];   // posted {id, target} challenges not yet won
        const winners = [];

        try {
            for (const target of candidates) {
                if (winners.length >= slots) break;
                this._throwIfBotBlocked();

                let challenge = null;
                try {
                    challenge = await this._postOneChallenge(target, limit, increment, rated);
                } catch (err) {
                    if (err instanceof LichessRateLimited) {
                        throw err;
                    }
                    this.notifier.warn(`[Hunt] Challenge to ${target.username} threw: ${err?.message}`);
                    continue;
                }

                if (!challenge) {
                    continue;
                }

                pending.push(challenge);

                // Wait up to huntAcceptTimeoutMs for this specific challenge to be accepted.
                const deadline = this._now() + this.huntAcceptTimeoutMs;
                let accepted = false;
                while (this._now() < deadline) {
                    await new Promise(r => setTimeout(r, this.huntPollIntervalMs));
                    if (this.activeGames.has(challenge.id)) {
                        accepted = true;
                        break;
                    }
                }

                if (accepted) {
                    winners.push(challenge);
                } else {
                    // Ignored within the window — cancel so we can try the next one.
                    await this.cancelChallenge(challenge.id);
                }
            }
        } catch (err) {
            // Cancel everything we posted that didn't become a game; don't mark any
            // bot declined — a rate-limit abort isn't a snub.
            const toCancel = pending.filter(p => !winners.includes(p));
            await Promise.allSettled(toCancel.map(({id}) => this.cancelChallenge(id)));
            throw err;
        }

        // Hunt completed normally: cool-down the bots we challenged that never accepted.
        for (const {target} of pending.filter(p => !winners.includes(p))) {
            this._markDeclined(target.username);
        }

        return winners;
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
            this._profileCache = {data: await res.json(), time: this._now()};
        }
        const profile = this._profileCache.data;
        const rating = profile.perfs?.[perf]?.rating;
        if (rating == null) throw new Error(`No ${perf} rating on profile yet`);
        return {rating, prov: !!profile.perfs[perf].prov};
    }

    // Challenge bots within ±window of our own rating for the given TC, ordered
    // by closeness in rating, until `count` games have started. `count` is how
    // many open slots autoplay wants filled (1 for a manual one-off challenge).
    async huntNearRating(limit, increment, rated = true, {window = 200, count = 1, poolSize = 80, maxWindow = 2000} = {}) {
        this._throwIfBotBlocked();
        const perf = this._performanceFromTimeControl(limit, increment);
        const {rating: myRating, prov} = await this._fetchMyRating(perf);
        this.notifier.info(`[Hunt] My ${perf} rating: ${myRating}${prov ? " (provisional)" : ""}; window ±${window} (max ±${maxWindow})`);

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
            this.notifier.info(`[Hunt] Empty pool at ±${currentWindow} (${inWindow.length} eligible, ${filteredOut} in cool-down) — widening to ±${next}`);
            currentWindow = next;
        }

        if (filteredOut > 0) {
            this.notifier.info(`[Hunt] Skipped ${filteredOut} bot(s) in decline cool-down (active: ${this.recentlyDeclined.size})`);
        }

        // Fisher-Yates shuffle.
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const candidates = pool.slice(0, count);

        if (candidates.length === 0) {
            const reason = filteredOut > 0
                ? `all ${filteredOut} bot(s) within ±${currentWindow} in cool-down`
                : `none within ±${currentWindow} of ${perf}=${myRating}`;
            throw new Error(`No challengeable bots — ${reason} (saw ${bots.length} online)`);
        }

        const widenedNote = currentWindow !== widenedFrom ? ` (widened ±${widenedFrom}→±${currentWindow})` : "";
        this.notifier.info(`[Hunt] ${candidates.length} candidates from pool of ${pool.length}${widenedNote}; filling up to ${count} slot(s)`);
        for (const c of candidates) {
            this.notifier.info(`[Hunt]   ${c.username} (${perf}=${c.perfs[perf].rating}, Δ${c._delta})`);
        }

        const winners = await this._raceChallenges(candidates, limit, increment, rated, count);
        if (winners.length > 0) {
            if (count === 1) {
                const w = winners[0];
                const r = w.target.perfs[perf].rating;
                return {status: "success", message: `Playing vs ${w.target.username} (${r})`, gameId: w.id, myRating, targetRating: r};
            }
            return {status: "success", message: `Started ${winners.length} game(s)`, started: winners.length, gameIds: winners.map(w => w.id), myRating};
        }

        throw new Error(`Hunt failed — none of ${candidates.length} near-rating bots accepted`);
    }

    async huntWeakestBot(limit, increment, rated = true, count = 1) {
        this._throwIfBotBlocked();
        this.notifier.info(`Hunting weakest bots (${limit}+${increment}, ${rated ? "rated" : "casual"}, up to ${count})...`);

        const bots = await this._fetchOnlineBots(500);

        this._pruneDeclined();

        const eligible = bots
        .filter(b => b.id !== this.botProfile?.toLowerCase())
        .filter(b => b.perfs?.blitz?.rating != null);

        const filteredOut = eligible.filter(b => this._inDeclineCooldown(b.username)).length;
        // One spare beyond the slots we want to fill, so a single ignoring bot
        // doesn't waste the hunt.
        const candidates = eligible
        .filter(b => !this._inDeclineCooldown(b.username))
        .sort((a, b) => a.perfs.blitz.rating - b.perfs.blitz.rating)
        .slice(0, count + 1);

        if (filteredOut > 0) {
            this.notifier.info(`[Hunt] Skipped ${filteredOut} bot(s) in decline cool-down`);
        }

        if (candidates.length === 0) throw new Error("No candidates found");

        this.notifier.info(`[Hunt] ${candidates.length} weakest candidates; filling up to ${count} slot(s)`);
        const winners = await this._raceChallenges(candidates, limit, increment, rated, count);
        if (winners.length > 0) {
            if (count === 1) {
                return {status: "success", message: `Playing vs ${winners[0].target.username}`, gameId: winners[0].id};
            }
            return {status: "success", message: `Started ${winners.length} game(s)`, started: winners.length, gameIds: winners.map(w => w.id)};
        }

        throw new Error("Hunt failed — all candidates ignored our challenges.");
    }

    // Teams the bot belongs to. Bots are barred from official Lichess arenas, so
    // the only tournaments we can join are team arenas run by a team we're in.
    async fetchBotTeams() {
        if (!this.botProfile) return [];
        const res = await this._lichessFetch(`https://lichess.org/api/team/of/${this.botProfile}`, {
            headers: this.authHeader,
        });
        if (!res.ok) throw new Error(`Failed to fetch teams for ${this.botProfile}: HTTP ${res.status}`);
        return res.json();
    }

    // Tournaments a team runs (kind = "arena" | "swiss"), as an ndjson stream.
    // Same body-read guard as _fetchOnlineBots so a stalled connection can't hang
    // the whole hunt.
    async _streamTeamTournaments(teamId, kind, max = 30) {
        const res = await this._lichessFetch(`https://lichess.org/api/team/${teamId}/${kind}?max=${max}`, {
            headers: {Accept: "application/x-ndjson"},
        });
        if (!res.ok) throw new Error(`Failed to fetch ${kind} for team ${teamId}: HTTP ${res.status}`);

        const out = [];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(new Error(`Team-${kind} stream timed out`)), 15000);
        try {
            await this.readNdjsonStream(res.body, controller.signal, (t) => out.push(t));
        } finally {
            clearTimeout(timeoutId);
        }
        if (controller.signal.aborted) {
            throw new Error(`Timed out streaming ${kind} for team ${teamId}`);
        }
        return out;
    }

    fetchTeamArenas(teamId, max = 30) { return this._streamTeamTournaments(teamId, "arena", max); }

    fetchTeamSwiss(teamId, max = 30) { return this._streamTeamTournaments(teamId, "swiss", max); }

    // Ask Lichess whether our account satisfies an arena's entry conditions
    // (rating caps, min rated games, etc.) before we burn a join attempt.
    // Returns true unless Lichess explicitly says we're rejected.
    async isEligibleForTournament(tournamentId) {
        const res = await this._lichessFetch(`https://lichess.org/api/tournament/${tournamentId}`, {
            headers: this.authHeader,
        });
        if (!res.ok) return false;
        const data = await res.json();
        return data?.verdicts?.accepted !== false;
    }

    async joinTournament(tournamentId) {
        const res = await this._lichessFetch(`https://lichess.org/api/tournament/${tournamentId}/join`, {
            method: "POST",
            headers: this.authHeader
        });
        
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText);
        }
        
        try {
            return await res.json();
        } catch {
            return { ok: true };
        }
    }

    async joinSwiss(swissId) {
        const res = await this._lichessFetch(`https://lichess.org/api/swiss/${swissId}/join`, {
            method: "POST",
            headers: this.authHeader,
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText);
        }
        try {
            return await res.json();
        } catch {
            return { ok: true };
        }
    }

    // Normalize an arena or swiss tournament into one shape for the UI + hunting.
    _normalizeTournament(t, type) {
        if (type === "arena") {
            return {
                id: t.id, type: "arena", name: t.fullName ?? t.id,
                startsAt: t.startsAt ?? 0,
                status: t.status === 10 ? "created" : t.status === 20 ? "started" : "finished",
                variant: t.variant?.key ?? "standard",
                nbPlayers: t.nbPlayers ?? 0,
            };
        }
        return {
            id: t.id, type: "swiss", name: t.name ?? t.id,
            startsAt: t.startsAt ? new Date(t.startsAt).getTime() : 0,
            status: t.status ?? "created",
            variant: (typeof t.variant === "string" ? t.variant : t.variant?.key) ?? "standard",
            nbPlayers: t.nbPlayers ?? 0,
        };
    }

    // Upsert discovered tournaments into the tracked map; prune finished/stale.
    _recordTournaments(list) {
        const now = this._now();
        for (const t of list) {
            const existing = this.tournaments.get(t.id);
            this.tournaments.set(t.id, {
                ...t,
                joined: existing?.joined || this.joinedTournaments.has(t.id),
                seenAt: now,
            });
        }
        for (const [id, t] of this.tournaments) {
            const stale = (t.status === "finished" && now - (t.seenAt ?? 0) > 60 * 60 * 1000)
                || now - (t.seenAt ?? 0) > 24 * 60 * 60 * 1000;
            if (stale) this.tournaments.delete(id);
        }
    }

    // Snapshot for the frontend: everything found, soonest first, each flagged
    // joined (and "playing" when joined and currently running).
    getTournaments() {
        return [...this.tournaments.values()]
            .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0))
            .map(({seenAt, ...t}) => ({...t, playing: !!t.joined && t.status === "started"}));
    }

    async huntTournaments(slots) {
        this.notifier.info(`[Hunt] Hunting for tournaments to fill ${slots} slot(s)...`);

        if (!this.botProfile) {
            this.notifier.info("[Hunt] No bot profile resolved yet; skipping tournament hunt");
            return;
        }

        let teams;
        try {
            teams = await this.fetchBotTeams();
        } catch (err) {
            if (err instanceof LichessRateLimited) throw err;
            this.notifier.warn(`[Hunt] Could not fetch bot teams: ${err.message}`);
            return;
        }

        if (!teams || teams.length === 0) {
            this.notifier.info("[Hunt] Bot is in no teams — join teams that run bot tournaments (e.g. a daily arena/swiss team).");
            return;
        }

        // Widen the net: every arena AND swiss across every team the bot is in.
        const found = [];
        const seen = new Set();
        for (const team of teams) {
            const teamId = team?.id ?? team;
            if (!teamId) continue;

            for (const kind of ["arena", "swiss"]) {
                try {
                    const list = await this._streamTeamTournaments(teamId, kind);
                    for (const t of list) {
                        if (!t?.id || seen.has(t.id)) continue;
                        seen.add(t.id);
                        found.push(this._normalizeTournament(t, kind));
                    }
                } catch (err) {
                    if (err instanceof LichessRateLimited) throw err;
                    this.notifier.warn(`[Hunt] Could not fetch ${kind} for team ${teamId}: ${err.message}`);
                }
            }
        }

        // Record everything so the frontend can show found / joined / playing.
        this._recordTournaments(found);

        // Joinable = upcoming or ongoing, standard, not already joined; soonest first.
        const joinable = found
            .filter(t => t.status === "created" || t.status === "started")
            .filter(t => t.variant === "standard")
            .filter(t => !this.joinedTournaments.has(t.id))
            .sort((a, b) => a.startsAt - b.startsAt);

        if (joinable.length === 0) {
            this.notifier.info(`[Hunt] Found ${found.length} tournament(s); none joinable right now`);
            return;
        }

        this.notifier.info(`[Hunt] ${joinable.length} joinable tournament(s); joining the soonest ${Math.min(slots, joinable.length)}`);

        let joined = 0;
        for (const t of joinable) {
            if (joined >= slots) break;

            // Arenas expose entry verdicts; check before burning a join. Swiss we
            // just attempt (the join response is the arbiter).
            if (t.type === "arena") {
                let eligible = true;
                try {
                    eligible = await this.isEligibleForTournament(t.id);
                } catch (err) {
                    if (err instanceof LichessRateLimited) throw err;
                }
                if (!eligible) {
                    this.notifier.info(`[Hunt] Skipping ${t.id} (${t.name}) — bot not eligible`);
                    this.joinedTournaments.add(t.id);
                    continue;
                }
            }

            try {
                this.notifier.info(`[Hunt] Joining ${t.type} ${t.id} (${t.name})...`);
                if (t.type === "swiss") await this.joinSwiss(t.id);
                else await this.joinTournament(t.id);
                this.notifier.info(`[Hunt] Joined ${t.id}`);
                this.joinedTournaments.add(t.id);
                const tracked = this.tournaments.get(t.id);
                if (tracked) tracked.joined = true;
                joined++;
            } catch (err) {
                if (err instanceof LichessRateLimited) throw err;
                this.notifier.warn(`[Hunt] Failed to join ${t.id}: ${err.message}`);
                this.joinedTournaments.add(t.id);
            }
        }
    }

    // FIXME: refactor for apiTransport
    async _lichessFetch(url: string, options: LichessFetchOptions = {}) {
        if (this._isRateLimited()) {
            throw new LichessRateLimited(this._rateLimitRemainingSec());
        }

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
            res = await this.apiTransport.request(url, {
                ...options, 
                signal: controller.signal, 
                rawResponse: true, 
                throwOnError: false
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (res.status === 429) {
            const error = await LichessRateLimited.fromResponse(res, this.defaultRetryAfterSec);
            this.notifier.error(`[Lichess API] 429 Rate Limited. Response body: ${error.bodyText}`);

            // The daily bot-games cap blocks only bot challenges, so it lands in
            // its own window; a generic 429 throttles the whole account.
            if (error instanceof LichessMaxBotGamesReached) {
                this._setMaxBotGamesLimit(error.retryAfterSec);
                error.retryAfterSec = this._maxBotGamesRemainingSec() || error.retryAfterSec;
            } else {
                this._setRateLimit(error.retryAfterSec);
                error.retryAfterSec = this._rateLimitRemainingSec() || error.retryAfterSec;
            }
            throw error;
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
            // This is a finite stream that should drain in a second or two. The
            // _lichessFetch timeout only covers receiving headers, so guard the
            // body read separately — otherwise a stalled connection hangs the
            // whole hunt (and autoplay) indefinitely.
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(new Error("Online-bots stream timed out")), 15000);
            try {
                await this.readNdjsonStream(res.body, controller.signal, (bot) => {
                    bots.push(bot);
                });
            } finally {
                clearTimeout(timeoutId);
            }
            if (controller.signal.aborted) {
                throw new Error("Timed out streaming online bots from Lichess");
            }
            this._onlineBotsCache = {data: bots, time: this._now()};
        }
        return this._onlineBotsCache.data;
    }

    async readNdjsonStream(readableStream, signal, callback) {
        const reader = readableStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const onAbort = () => reader.cancel().catch(() => {
        });
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
                        this.notifier.error("[NDJSON] Callback error:", e);
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
