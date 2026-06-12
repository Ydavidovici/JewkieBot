import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";

// Build a fake fetch Response for tests — `Headers` semantics matter for 429
// handling (Retry-After lookup is case-insensitive).
function rateLimitResponse(retryAfterSec) {
    const headers = new Headers();
    if (retryAfterSec != null) headers.set("Retry-After", String(retryAfterSec));
    return {
        ok: false,
        status: 429,
        headers,
        text: async () => '{"error":"Too many requests."}',
    };
}

let dbInserts = [];
let dbUpdates = [];

const mockDbClient = {
    createGame: async (payload) => {
        dbInserts.push({ table: "PLAYERS", data: { name: payload.whiteUsername } });
        dbInserts.push({ table: "PLAYERS", data: { name: payload.blackUsername } });
        dbInserts.push({ table: "GAMES", data: payload });
        return { id: 42 };
    },
    updateGame: async (id, payload) => {
        dbUpdates.push({ table: "GAMES", data: payload });
    },
    getGameMoves: async () => [],
    insertGameMoves: async (id, moves) => {
        dbInserts.push({ table: "GAME_MOVES", data: moves });
    }
};

mock.module("../src/dbClient.js", () => ({ dbClient: mockDbClient }));

const { LichessBot, LichessRateLimited, normalizeMove, mapResult, extractTime } = await import("../src/lichessBot.js");

class MockEngine extends EventEmitter {
    constructor() {
        super();
        this.start = mock(async () => {});
        this.uciNewGame = mock(async () => {});
        this.position = mock(async () => {});
        this.setOption = mock(async () => {});
        this.go = mock(async () => "e2e4");
        this.stop = mock(async () => {});
    }
}

function createMockStream(items) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const item of items) {
                controller.enqueue(encoder.encode(JSON.stringify(item) + "\n"));
            }
            controller.close();
        },
    });
}

async function waitFor(conditionFn, timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            if (conditionFn()) return;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 10));
    }
    conditionFn();
}

function makeGameFull(gameId, botId, opts = {}) {
    const clock = opts.clock === null
        ? null
        : { initial: opts.clock?.initial ?? 180000, increment: opts.clock?.increment ?? 2000 };

    return {
        type: "gameFull",
        initialFen: opts.fen ?? "startpos",
        white: { id: opts.white ?? botId, rating: 1500 },
        black: { id: opts.black ?? "opponent", rating: 1400 },
        variant: { key: "standard" },
        rated: false,
        clock,
        state: {
            moves: opts.moves ?? "",
            wtime: opts.wtime ?? 60000,
            btime: opts.btime ?? 60000,
            winc: opts.winc ?? 1000,
            binc: opts.binc ?? 1000,
            status: opts.status ?? "started",
            winner: opts.winner ?? undefined,
        },
    };
}

let bot;
let engine;
let originalFetch;

function makeBot(options = {}) {
    return new LichessBot("fake_token", () => engine, { apiSpacingMs: 0, challengeSpacingMs: 0, ...options });
}

beforeEach(() => {
    engine = new MockEngine();
    bot = makeBot();
    originalFetch = global.fetch;
    dbInserts = [];
    dbUpdates = [];
});

afterEach(() => {
    global.fetch = originalFetch;
    bot.stop();
});

describe("Promotion normalization", () => {
    it("sends a lowercase promotion piece to Lichess when engine returns uppercase", async () => {
        const gameId = "promo_test";
        engine.go = mock(async () => "e7e8Q");

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([makeGameFull(gameId, "bot")]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining(`/move/e7e8q`),
                expect.any(Object)
            );
        });
    });

    it("does not modify normal 4-character moves", async () => {
        const gameId = "normal_move";
        engine.go = mock(async () => "d2d4");

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([makeGameFull(gameId, "bot")]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining(`/move/d2d4`),
                expect.any(Object)
            );
        });
    });
});


describe("isMyTurn logic", () => {
    async function setupGame(gameId, gameFull) {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gameFull]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
    }

    it("makes a move when bot is white and no moves have been played", async () => {
        await setupGame("t1", makeGameFull("t1", "bot", { white: "bot", black: "opp", moves: "" }));
        await waitFor(() => expect(engine.go).toHaveBeenCalled());
    });

    it("does NOT make a move when bot is black and no moves have been played", async () => {
        await setupGame("t2", makeGameFull("t2", "bot", { white: "opp", black: "bot", moves: "" }));
        await new Promise(r => setTimeout(r, 150));
        expect(engine.go).not.toHaveBeenCalled();
    });

    it("makes a move when bot is black after white's first move", async () => {
        await setupGame("t3", makeGameFull("t3", "bot", { white: "opp", black: "bot", moves: "e2e4" }));
        await waitFor(() => expect(engine.go).toHaveBeenCalled());
    });

    it("does NOT make a move when bot is white after white's first move", async () => {
        await setupGame("t4", makeGameFull("t4", "bot", { white: "bot", black: "opp", moves: "e2e4" }));
        await new Promise(r => setTimeout(r, 150));
        expect(engine.go).not.toHaveBeenCalled();
    });

    it("makes a move when bot is white after both sides have moved once", async () => {
        await setupGame("t5", makeGameFull("t5", "bot", { white: "bot", black: "opp", moves: "e2e4 e7e5" }));
        await waitFor(() => expect(engine.go).toHaveBeenCalled());
    });
});

describe("start()", () => {
    it("fetches bot profile and sets botProfile", async () => {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "my-engine-bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([]) };
            return { ok: false };
        });

        await bot.start();

        expect(bot.botProfile).toBe("my-engine-bot");
    });

    it("calls engine.start() per game (not on bot.start)", async () => {
        const gameId = "engine_start_test";

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([makeGameFull(gameId, "bot")]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();
        expect(engine.start).not.toHaveBeenCalled();

        await waitFor(() => expect(engine.start).toHaveBeenCalledTimes(1));
    });

    it("throws if /api/account returns a non-OK response", async () => {
        global.fetch = mock(async () => ({ ok: false, statusText: "Unauthorized" }));

        await expect(bot.start()).rejects.toThrow("Failed to fetch bot profile");
    });
});

describe("stop()", () => {
    it("sets eventController to null and clears activeGames", async () => {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) {
                return { ok: true, body: new ReadableStream({ start() {} }) };
            }
            return { ok: false };
        });

        await bot.start();

        expect(bot.eventController).not.toBeNull();

        bot.stop();

        expect(bot.eventController).toBeNull();
        expect(bot.activeGames.size).toBe(0);
    });

    it("aborts all active game streams", async () => {
        bot.activeGames.add("game_abc");
        const gameController = new AbortController();
        bot.gameControllers.set("game_abc", gameController);

        bot.stop();

        expect(gameController.signal.aborted).toBe(true);
        expect(bot.gameControllers.size).toBe(0);
    });

    it("is safe to call when bot was never started", () => {
        expect(() => bot.stop()).not.toThrow();
    });
});

describe("handleChallenge()", () => {
    it("accepts standard chess challenges", async () => {
        const event = {
            type: "challenge",
            challenge: { id: "ch_std", variant: { key: "standard" } },
        };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([event]) };
            if (url.includes("/challenge/ch_std/accept")) return { ok: true };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/challenge/ch_std/accept"),
                expect.objectContaining({ method: "POST" })
            );
        });
    });

    it("declines challenges with a non-standard variant", async () => {
        const event = {
            type: "challenge",
            challenge: { id: "ch_960", variant: { key: "chess960" } },
        };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([event]) };
            if (url.includes("/challenge/ch_960/decline")) return { ok: true };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/challenge/ch_960/decline"),
                expect.any(Object)
            );
        });
    });

    it("declines a standard challenge when at the concurrency cap", async () => {
        bot = makeBot({ maxConcurrentGames: 1 });

        const event = {
            type: "challenge",
            challenge: { id: "ch_busy", variant: { key: "standard" } },
        };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([event]) };
            if (url.includes("/challenge/ch_busy/decline")) return { ok: true };
            return { ok: false };
        });

        bot.activeGames.add("ongoing_game");
        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/challenge/ch_busy/decline"),
                expect.any(Object)
            );
        });
    });

    it("does NOT accept the challenge when at the cap — no accept call made", async () => {
        bot = makeBot({ maxConcurrentGames: 1 });

        const event = {
            type: "challenge",
            challenge: { id: "ch_no_accept", variant: { key: "standard" } },
        };

        let acceptCalled = false;
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([event]) };
            if (url.includes("/challenge/ch_no_accept/accept")) { acceptCalled = true; return { ok: true }; }
            if (url.includes("/challenge/ch_no_accept/decline")) return { ok: true };
            return { ok: false };
        });

        bot.activeGames.add("ongoing_game");
        await bot.start();

        await new Promise(r => setTimeout(r, 200));
        expect(acceptCalled).toBe(false);
    });

    it("accepts a second challenge below the cap (default cap is 4)", async () => {
        const event = {
            type: "challenge",
            challenge: { id: "ch_second", variant: { key: "standard" } },
        };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([event]) };
            if (url.includes("/challenge/ch_second/accept")) return { ok: true };
            return { ok: false };
        });

        bot.activeGames.add("ongoing_game");
        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/challenge/ch_second/accept"),
                expect.objectContaining({ method: "POST" })
            );
        });
    });
});

describe("Time-control flexibility", () => {
    const timeControls = [
        { name: "bullet (60+0)",       limit: 60,    increment: 0  },
        { name: "blitz (3+2)",         limit: 180,   increment: 2  },
        { name: "rapid (10+0)",        limit: 600,   increment: 0  },
        { name: "classical (30+15)",   limit: 1800,  increment: 15 },
        { name: "custom (7+3)",        limit: 420,   increment: 3  },
    ];

    for (const tc of timeControls) {
        it(`accepts a standard challenge with ${tc.name}`, async () => {
            const event = {
                type: "challenge",
                challenge: {
                    id: `ch_${tc.limit}_${tc.increment}`,
                    variant: { key: "standard" },
                    timeControl: { limit: tc.limit, increment: tc.increment },
                },
            };

            global.fetch = mock(async (url) => {
                if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
                if (url.includes("/stream/event")) return { ok: true, body: createMockStream([event]) };
                if (url.includes(`/challenge/${event.challenge.id}/accept`)) return { ok: true };
                return { ok: false };
            });

            await bot.start();

            await waitFor(() => {
                expect(global.fetch).toHaveBeenCalledWith(
                    expect.stringContaining(`/challenge/${event.challenge.id}/accept`),
                    expect.objectContaining({ method: "POST" })
                );
            });
        });
    }
});

describe("Challenge creation", () => {
    function captureChallengeBody() {
        let captured = null;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/api/challenge/")) {
                captured = opts?.body?.toString() ?? "";
                return { ok: true, json: async () => ({ id: "fake_challenge" }) };
            }
            return { ok: false };
        });
        return () => captured;
    }

    it("createOpenChallenge defaults to rated=true with the requested time control", async () => {
        const getBody = captureChallengeBody();
        bot.botProfile = "bot";

        await bot.createOpenChallenge(600, 5);

        const body = getBody();
        expect(body).toContain("clock.limit=600");
        expect(body).toContain("clock.increment=5");
        expect(body).toContain("rated=true");
    });

    it("createOpenChallenge supports rated=false for casual games", async () => {
        const getBody = captureChallengeBody();
        bot.botProfile = "bot";

        await bot.createOpenChallenge(1800, 15, false);

        const body = getBody();
        expect(body).toContain("clock.limit=1800");
        expect(body).toContain("clock.increment=15");
        expect(body).toContain("rated=false");
    });

    it("createChallenge supports arbitrary time controls", async () => {
        const getBody = captureChallengeBody();
        bot.botProfile = "bot";

        await bot.createChallenge("opponent", 420, 3);

        const body = getBody();
        expect(body).toContain("clock.limit=420");
        expect(body).toContain("clock.increment=3");
    });

    it("createAiChallenge passes time control through to Lichess", async () => {
        const getBody = captureChallengeBody();
        bot.botProfile = "bot";

        await bot.createAiChallenge(3, 600, 0);

        const body = getBody();
        expect(body).toContain("level=3");
        expect(body).toContain("clock.limit=600");
        expect(body).toContain("clock.increment=0");
    });
});

describe("streamEvents() routing", () => {
    it("opens a game stream when a gameStart event is received", async () => {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: "g1" } }]) };
            if (url.includes("/bot/game/stream/g1")) return { ok: true, body: createMockStream([]) };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/bot/game/stream/g1"),
                expect.any(Object)
            );
        });
    });

    it("does not open a game stream for unrecognized event types", async () => {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "unknown" }]) };
            return { ok: false };
        });

        await bot.start();
        await new Promise(r => setTimeout(r, 100));

        const gameStreamCalls = global.fetch.mock.calls.filter(([url]) =>
            url.includes("/bot/game/stream/")
        );
        expect(gameStreamCalls).toHaveLength(0);
    });
});

describe("playGame() — gameFull event", () => {
    it("adds the gameId to activeGames while the stream is open", async () => {
        const gameId = "active_test";
        let streamCtrl;

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) {
                return {
                    ok: true,
                    body: new ReadableStream({ start(c) { streamCtrl = c; } }),
                };
            }
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();
        await new Promise(r => setTimeout(r, 100));

        expect(bot.activeGames.has(gameId)).toBe(true);

        streamCtrl?.close();
        await new Promise(r => setTimeout(r, 50));
        expect(bot.activeGames.has(gameId)).toBe(false);
    });

    it("does not enter the same game twice", async () => {
        const gameId = "dedup";
        let streamCtrl;

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) {
                return { ok: true, body: new ReadableStream({ start(c) { streamCtrl = c; } }) };
            }
            return { ok: false };
        });

        await bot.start();
        await new Promise(r => setTimeout(r, 50));

        await bot.playGame(gameId);

        const openStreams = global.fetch.mock.calls.filter(([url]) =>
            url.includes(`/bot/game/stream/${gameId}`)
        );
        expect(openStreams).toHaveLength(1);

        streamCtrl?.close();
    });

    it("calls uciNewGame before sending the first position", async () => {
        const gameId = "uci_order";

        const callOrder = [];
        engine.uciNewGame = mock(async () => { callOrder.push("uciNewGame"); });
        engine.position = mock(async () => { callOrder.push("position"); });
        engine.go = mock(async () => "e2e4");

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([makeGameFull(gameId, "bot")]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => expect(callOrder).toContain("position"));

        expect(callOrder.indexOf("uciNewGame")).toBeLessThan(callOrder.indexOf("position"));
    });

    it("sends the correct position and makes a move on bot's turn", async () => {
        const gameId = "move_test";

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) {
                return { ok: true, body: createMockStream([makeGameFull(gameId, "bot", { moves: "e2e4 e7e5" })]) };
            }
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => expect(engine.position).toHaveBeenCalled());

        expect(engine.position).toHaveBeenCalledWith("startpos", ["e2e4", "e7e5"]);
        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining(`/bot/game/${gameId}/move/e2e4`),
                expect.any(Object)
            );
        });
    });
});

describe("playGame() — gameState event", () => {
    it("makes a move when a gameState event signals it's the bot's turn", async () => {
        const gameId = "state_test";
        engine.go = mock(async () => "g1f3");

        const gameState = {
            type: "gameState",
            moves: "e2e4 e7e5 g1f3",
            wtime: 58000, btime: 59000, winc: 1000, binc: 1000,
            status: "started",
        };

        const gameFull2 = makeGameFull(gameId, "bot", {
            white: "opp", black: "bot", moves: "e2e4 e7e5",
        });

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) {
                return { ok: true, body: createMockStream([gameFull2, gameState]) };
            }
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();

        await waitFor(() => {
            expect(engine.go.mock.calls.length).toBeGreaterThanOrEqual(1);
        });
    });
});

describe("Game over", () => {
    async function playUntilOver(gameId, events) {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream(events) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
    }

    it("removes the game from activeGames on game over", async () => {
        const gameId = "over_test";
        const endState = {
            type: "gameState",
            moves: "e2e4 e7e5",
            wtime: 60000, btime: 60000, winc: 0, binc: 0,
            status: "mate",
            winner: "white",
        };

        await playUntilOver(gameId, [
            makeGameFull(gameId, "bot", { white: "opp", black: "bot" }),
            endState,
        ]);

        await waitFor(() => expect(bot.activeGames.has(gameId)).toBe(false));
    });

    it("does not call engine.go after a game-over status", async () => {
        const gameId = "no_move_after_end";
        const gameFull = makeGameFull(gameId, "bot", {
            white: "bot", black: "opp",
            status: "mate",
            winner: "black",
        });
        gameFull.state.status = "mate";
        gameFull.state.winner = "black";

        await playUntilOver(gameId, [gameFull]);

        await new Promise(r => setTimeout(r, 150));
        expect(engine.go).not.toHaveBeenCalled();
    });
});

describe("Resignation", () => {
    async function expectResign(gameId, engineMove) {
        engine.go = mock(async () => engineMove);

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([makeGameFull(gameId, "bot")]) };
            return { ok: true };
        });

        await bot.start();

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining(`/bot/game/${gameId}/resign`),
                expect.objectContaining({ method: "POST" })
            );
        });
    }

    it("resigns when engine returns (none)", () => expectResign("res1", "(none)"));
    it("resigns when engine returns 0000",  () => expectResign("res2", "0000"));
    it("resigns when engine returns null",  () => expectResign("res3", null));
});

describe("Concurrent games", () => {
    it("spawns a separate engine per game and runs both in parallel", async () => {
        const engines = [];
        const factory = () => {
            const e = new MockEngine();
            engines.push(e);
            return e;
        };
        const concurrentBot = new LichessBot("fake_token", factory, { maxConcurrentGames: 4 });

        const gameIds = ["concA", "concB"];
        let streamCtrls = {};

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) {
                return {
                    ok: true,
                    body: createMockStream(gameIds.map(id => ({ type: "gameStart", game: { id } }))),
                };
            }
            for (const id of gameIds) {
                if (url.includes(`/bot/game/stream/${id}`)) {
                    return {
                        ok: true,
                        body: new ReadableStream({
                            start(c) {
                                streamCtrls[id] = c;
                                const enc = new TextEncoder();
                                c.enqueue(enc.encode(JSON.stringify(makeGameFull(id, "bot")) + "\n"));
                            },
                        }),
                    };
                }
            }
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await concurrentBot.start();

        await waitFor(() => {
            expect(concurrentBot.activeGames.size).toBe(2);
            expect(engines.length).toBe(2);
        });

        await waitFor(() => {
            expect(engines[0].start).toHaveBeenCalledTimes(1);
            expect(engines[1].start).toHaveBeenCalledTimes(1);
            expect(engines[0].go).toHaveBeenCalled();
            expect(engines[1].go).toHaveBeenCalled();
        });

        for (const c of Object.values(streamCtrls)) c.close();
        await waitFor(() => expect(concurrentBot.activeGames.size).toBe(0));

        expect(engines[0].stop).toHaveBeenCalled();
        expect(engines[1].stop).toHaveBeenCalled();

        concurrentBot.stop();
    });
});

describe("DB integration", () => {
    async function runGame(gameId, events) {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream(events) };
            if (url.includes("/move/")) return { ok: true };
            if (url.includes("/resign")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
    }

    it("upserts both players when a game starts", async () => {
        const gf = makeGameFull("db1", "bot", { white: "bot", black: "opponent" });
        await runGame("db1", [gf]);

        await waitFor(() => {
            const playerInserts = dbInserts.filter(i => i.table === "PLAYERS");
            expect(playerInserts.length).toBeGreaterThanOrEqual(2);
            const names = playerInserts.map(i => i.data.name);
            expect(names).toContain("bot");
            expect(names).toContain("opponent");
        });
    });

    it("creates a game record with Lichess metadata", async () => {
        const gf = makeGameFull("db2", "bot");
        await runGame("db2", [gf]);

        await waitFor(() => {
            const gameInsert = dbInserts.find(i => i.table === "GAMES");
            expect(gameInsert).toBeDefined();
            expect(gameInsert.data).toMatchObject({
                source: "lichess",
                lichessGameId: "db2",
                variant: "standard",
                rated: 0,
            });
        });
    });

    it("saves moves present in the initial gameFull state", async () => {
        const gf = makeGameFull("db3", "bot", { white: "opp", black: "bot", moves: "e2e4 e7e5" });
        await runGame("db3", [gf]);

        await waitFor(() => {
            const moveInserts = dbInserts.filter(i => i.table === "GAME_MOVES");
            expect(moveInserts.length).toBeGreaterThanOrEqual(1);
            const flatMoves = moveInserts.flatMap(i =>
                Array.isArray(i.data) ? i.data : [i.data]
            );
            expect(flatMoves).toContainEqual(expect.objectContaining({ ply: 1, uci: "e2e4" }));
            expect(flatMoves).toContainEqual(expect.objectContaining({ ply: 2, uci: "e7e5" }));
        });
    });

    it("saves only NEW moves from a gameState event (no duplicates)", async () => {
        const gameId = "db4";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot", moves: "e2e4" });
        const gs = {
            type: "gameState",
            moves: "e2e4 e7e5",
            wtime: 59000, btime: 60000, winc: 1000, binc: 1000,
            status: "started",
        };

        await runGame(gameId, [gf, gs]);

        await waitFor(() => {
            const flatMoves = dbInserts
                .filter(i => i.table === "GAME_MOVES")
                .flatMap(i => Array.isArray(i.data) ? i.data : [i.data]);

            const ply1s = flatMoves.filter(m => m.ply === 1 && m.uci === "e2e4");
            expect(ply1s).toHaveLength(1);

            const ply2s = flatMoves.filter(m => m.ply === 2 && m.uci === "e7e5");
            expect(ply2s).toHaveLength(1);
        });
    });

    it("writes result and termination on game over (white wins by mate)", async () => {
        const gameId = "db5";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = {
            type: "gameState",
            moves: "e2e4",
            wtime: 59000, btime: 60000, winc: 0, binc: 0,
            status: "mate",
            winner: "white",
        };

        await runGame(gameId, [gf, gs]);

        await waitFor(() => {
            const update = dbUpdates.find(u => u.data?.result === "1-0");
            expect(update).toBeDefined();
            expect(update.data).toMatchObject({ result: "1-0", termination: "mate" });
            expect(update.data.finished_at).toBeTruthy();
        });
    });

    it("emits a notifier event on game-over with status/winner/result", async () => {
        const events = [];
        const notifier = {
            info:  (subject, details) => events.push({level: "info",  subject, details}),
            warn:  (subject, details) => events.push({level: "warn",  subject, details}),
            error: (subject, details) => events.push({level: "error", subject, details}),
            fatal: (subject, details) => events.push({level: "fatal", subject, details}),
        };
        const localBot = new LichessBot("fake_token", () => engine, {notifier});

        const gameId = "notify_over";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = {
            type: "gameState",
            moves: "e2e4 e7e5",
            wtime: 59000, btime: 60000, winc: 0, binc: 0,
            status: "mate",
            winner: "white",
        };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf, gs]) };
            if (url.includes("/move/")) return { ok: true };
            if (url.includes("/resign")) return { ok: true };
            return { ok: false };
        });

        await localBot.start();

        await waitFor(() => {
            const gameOverEvent = events.find(e => typeof e.subject === "string" && e.subject.startsWith("[Game] Game over"));
            expect(gameOverEvent).toBeDefined();
            expect(gameOverEvent.subject).toContain(gameId);
            expect(gameOverEvent.details).toMatchObject({
                status: "mate",
                winner: "white",
                result: "1-0",
            });
        });
    });

    it("writes 0-1 result when black wins", async () => {
        const gameId = "db6";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = {
            type: "gameState",
            moves: "e2e4",
            wtime: 59000, btime: 60000, winc: 0, binc: 0,
            status: "resign",
            winner: "black",
        };

        await runGame(gameId, [gf, gs]);

        await waitFor(() => {
            expect(dbUpdates.some(u => u.data?.result === "0-1")).toBe(true);
        });
    });

    it("writes 1/2-1/2 for drawn games", async () => {
        const gameId = "db7";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = {
            type: "gameState",
            moves: "",
            wtime: 0, btime: 0, winc: 0, binc: 0,
            status: "draw",
            winner: null,
        };

        await runGame(gameId, [gf, gs]);

        await waitFor(() => {
            expect(dbUpdates.some(u => u.data?.result === "1/2-1/2")).toBe(true);
        });
    });

    it("writes 1/2-1/2 for stalemate", async () => {
        const gameId = "db8";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = {
            type: "gameState",
            moves: "",
            wtime: 0, btime: 0, winc: 0, binc: 0,
            status: "stalemate",
            winner: null,
        };

        await runGame(gameId, [gf, gs]);

        await waitFor(() => {
            expect(dbUpdates.some(u => u.data?.result === "1/2-1/2")).toBe(true);
        });
    });

    it("writes 1/2-1/2 for threefoldRepetition", async () => {
        const gameId = "db_tf";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "threefoldRepetition", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => expect(dbUpdates.some(u => u.data?.result === "1/2-1/2" && u.data?.termination === "threefoldRepetition")).toBe(true));
    });

    it("writes 1/2-1/2 for insufficient material", async () => {
        const gameId = "db_ins";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "insufficient", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => expect(dbUpdates.some(u => u.data?.result === "1/2-1/2" && u.data?.termination === "insufficient")).toBe(true));
    });

    it("writes 1/2-1/2 for fiftyMoves rule", async () => {
        const gameId = "db_fm";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "fiftyMoves", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => expect(dbUpdates.some(u => u.data?.result === "1/2-1/2" && u.data?.termination === "fiftyMoves")).toBe(true));
    });

    it("writes 1/2-1/2 for outoftime with null winner (insufficient-material flag fall)", async () => {
        const gameId = "db_oot";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "outoftime", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => expect(dbUpdates.some(u => u.data?.result === "1/2-1/2" && u.data?.termination === "outoftime")).toBe(true));
    });

    it("writes 1/2-1/2 for timeout with null winner", async () => {
        const gameId = "db_to";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "timeout", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => expect(dbUpdates.some(u => u.data?.result === "1/2-1/2" && u.data?.termination === "timeout")).toBe(true));
    });

    it("writes null result (with termination) for aborted games", async () => {
        const gameId = "db_ab";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "aborted", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => {
            const u = dbUpdates.find(x => x.data?.termination === "aborted");
            expect(u).toBeDefined();
            expect(u.data.result).toBeNull();
            expect(u.data.finished_at).toBeTruthy();
        });
    });

    it("writes null result for noStart with null winner", async () => {
        const gameId = "db_ns";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "noStart", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => {
            const u = dbUpdates.find(x => x.data?.termination === "noStart");
            expect(u).toBeDefined();
            expect(u.data.result).toBeNull();
        });
    });

    it("writes null result for unknownFinish", async () => {
        const gameId = "db_uf";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const gs = { type: "gameState", moves: "", wtime: 0, btime: 0, winc: 0, binc: 0, status: "unknownFinish", winner: null };
        await runGame(gameId, [gf, gs]);
        await waitFor(() => {
            const u = dbUpdates.find(x => x.data?.termination === "unknownFinish");
            expect(u).toBeDefined();
            expect(u.data.result).toBeNull();
        });
    });

    it("createDbGame: rated=true maps to 1", async () => {
        const gf = { ...makeGameFull("db_rated", "bot"), rated: true };
        await runGame("db_rated", [gf]);
        await waitFor(() => {
            const gi = dbInserts.find(i => i.table === "GAMES");
            expect(gi).toBeDefined();
            expect(gi.data.rated).toBe(1);
        });
    });

    it("createDbGame: null clock maps timeControl to null", async () => {
        const gf = makeGameFull("db_noclock", "bot", { clock: null });
        await runGame("db_noclock", [gf]);
        await waitFor(() => {
            const gi = dbInserts.find(i => i.table === "GAMES");
            expect(gi).toBeDefined();
            expect(gi.data.timeControl).toBeNull();
        });
    });

    it("saveNewMoves is a no-op when called for an unknown gameId", async () => {
        await bot.saveNewMoves("never_registered", "e2e4 e7e5");
        const moveInserts = dbInserts.filter(i => i.table === "GAME_MOVES");
        expect(moveInserts).toHaveLength(0);
    });

    it("finalizeDbGame is a no-op when called for an unknown gameId", async () => {
        await bot.finalizeDbGame("never_registered", "mate", "white");
        expect(dbUpdates).toHaveLength(0);
    });
});

describe("Pure helpers — normalizeMove", () => {
    it("returns null unchanged", () => {
        expect(normalizeMove(null)).toBeNull();
    });
    it("returns undefined unchanged", () => {
        expect(normalizeMove(undefined)).toBeUndefined();
    });
    it("returns empty string unchanged", () => {
        expect(normalizeMove("")).toBe("");
    });
    it("returns 4-char moves unchanged", () => {
        expect(normalizeMove("e2e4")).toBe("e2e4");
        expect(normalizeMove("g1f3")).toBe("g1f3");
    });
    it("lowercases uppercase promotion piece (Q→q, R→r, B→b, N→n)", () => {
        expect(normalizeMove("e7e8Q")).toBe("e7e8q");
        expect(normalizeMove("a7a8R")).toBe("a7a8r");
        expect(normalizeMove("h7h8B")).toBe("h7h8b");
        expect(normalizeMove("d7d8N")).toBe("d7d8n");
    });
    it("is idempotent on already-lowercase promotion moves", () => {
        expect(normalizeMove("e7e8q")).toBe("e7e8q");
        expect(normalizeMove("a7a8n")).toBe("a7a8n");
    });
    it("does not modify 3-char or 6-char strings", () => {
        expect(normalizeMove("e2e")).toBe("e2e");
        expect(normalizeMove("e2e4e5")).toBe("e2e4e5");
    });
});


describe("Pure helpers — mapResult", () => {
    it("winner === 'white' always wins (1-0), regardless of status", () => {
        expect(mapResult("mate", "white")).toBe("1-0");
        expect(mapResult("resign", "white")).toBe("1-0");
        expect(mapResult("draw", "white")).toBe("1-0");
    });
    it("winner === 'black' always loses for white (0-1)", () => {
        expect(mapResult("mate", "black")).toBe("0-1");
        expect(mapResult("outoftime", "black")).toBe("0-1");
    });
    it.each([
        ["draw"], ["stalemate"], ["threefoldRepetition"], ["insufficient"], ["fiftyMoves"],
        ["outoftime"], ["timeout"],
    ])("status=%s with null winner → 1/2-1/2", (status) => {
        expect(mapResult(status, null)).toBe("1/2-1/2");
    });
    it.each([
        ["aborted"], ["noStart"], ["unknownFinish"], ["created"], ["started"],
    ])("status=%s with null winner → null (no result)", (status) => {
        expect(mapResult(status, null)).toBeNull();
    });
    it("undefined winner is treated like null", () => {
        expect(mapResult("aborted", undefined)).toBeNull();
        expect(mapResult("draw", undefined)).toBe("1/2-1/2");
    });
});

describe("Pure helpers — extractTime", () => {
    it("returns {} for null state", () => {
        expect(extractTime(null)).toEqual({});
    });
    it("returns {} for undefined state", () => {
        expect(extractTime(undefined)).toEqual({});
    });
    it("extracts all four time fields", () => {
        expect(extractTime({ wtime: 1, btime: 2, winc: 3, binc: 4, foo: 5 })).toEqual({
            wtime: 1, btime: 2, winc: 3, binc: 4,
        });
    });
    it("includes undefined for missing fields", () => {
        const r = extractTime({ wtime: 100 });
        expect(r.wtime).toBe(100);
        expect(r.btime).toBeUndefined();
        expect(r.winc).toBeUndefined();
        expect(r.binc).toBeUndefined();
    });
});

describe("handleChallenge — edge cases", () => {
    async function runChallenge(challenge) {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "challenge", challenge }]) };
            if (url.includes("/challenge/")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
    }

    it("declines when variant is entirely missing", async () => {
        await runChallenge({ id: "ch_no_variant" });
        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/challenge/ch_no_variant/decline"),
                expect.any(Object),
            );
        });
    });

    it("declines when variant.key is missing", async () => {
        await runChallenge({ id: "ch_no_key", variant: {} });
        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/challenge/ch_no_key/decline"),
                expect.any(Object),
            );
        });
    });

    it("decline body includes reason=variant for non-standard variant", async () => {
        let declineBody;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "challenge", challenge: { id: "ch_v", variant: { key: "antichess" } } }]) };
            if (url.includes("/challenge/ch_v/decline")) { declineBody = opts?.body?.toString(); return { ok: true }; }
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => expect(declineBody).toBeTruthy());
        expect(declineBody).toContain("reason=variant");
    });

    it("decline body includes reason=later when at the cap", async () => {
        bot = makeBot({ maxConcurrentGames: 1 });
        bot.activeGames.add("ongoing");

        let declineBody;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "challenge", challenge: { id: "ch_l", variant: { key: "standard" } } }]) };
            if (url.includes("/challenge/ch_l/decline")) { declineBody = opts?.body?.toString(); return { ok: true }; }
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => expect(declineBody).toBeTruthy());
        expect(declineBody).toContain("reason=later");
    });
});

describe("declineChallenge", () => {
    it("uses 'generic' as default reason", async () => {
        let body;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/challenge/x/decline")) { body = opts?.body?.toString(); return { ok: true }; }
            return { ok: false };
        });
        await bot.declineChallenge("x");
        expect(body).toContain("reason=generic");
    });

    it("silently swallows network errors", async () => {
        global.fetch = mock(async () => { throw new Error("network down"); });
        await expect(bot.declineChallenge("x", "later")).resolves.toBeUndefined();
    });
});

describe("playGame — additional edge cases", () => {
    it("ignores chatLine events without making moves", async () => {
        const gameId = "chat_test";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const chat = { type: "chatLine", username: "x", text: "hi", room: "player" };
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf, chat, chat]) };
            return { ok: false };
        });
        await bot.start();
        await new Promise(r => setTimeout(r, 100));
        expect(engine.go).not.toHaveBeenCalled();
    });

    it("ignores opponentGone events", async () => {
        const gameId = "opp_gone";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const opp = { type: "opponentGone", gone: true, claimWinInSeconds: 60 };
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf, opp]) };
            return { ok: false };
        });
        await bot.start();
        await new Promise(r => setTimeout(r, 100));
        expect(engine.go).not.toHaveBeenCalled();
    });

    it("ignores unknown event types in the game stream", async () => {
        const gameId = "unknown_t";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot" });
        const weird = { type: "futureLichessEvent", foo: "bar" };
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf, weird]) };
            return { ok: false };
        });
        await bot.start();
        await new Promise(r => setTimeout(r, 100));
        expect(engine.go).not.toHaveBeenCalled();
    });

    it("passes a custom initialFen to engine.position", async () => {
        const gameId = "custom_fen";
        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot", fen, moves: "" });
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => expect(engine.position).toHaveBeenCalled());
        expect(engine.position).toHaveBeenCalledWith(fen, []);
    });

    it("falls back to 'ai' when white object is missing", async () => {
        const gameId = "missing_white";
        const gf = makeGameFull(gameId, "bot");
        delete gf.white;
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf]) };
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => {
            const names = dbInserts.filter(i => i.table === "PLAYERS").map(i => i.data.name);
            expect(names).toContain("ai");
        });
    });

    it("falls back to 'ai' when black object is missing", async () => {
        const gameId = "missing_black";
        const gf = makeGameFull(gameId, "bot");
        delete gf.black;
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => {
            const names = dbInserts.filter(i => i.table === "PLAYERS").map(i => i.data.name);
            expect(names).toContain("ai");
        });
    });

    it("uses obj.white.name when obj.white.id is missing", async () => {
        const gameId = "name_only";
        const gf = makeGameFull(gameId, "bot");
        gf.white = { name: "BotAccount" };
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf]) };
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => {
            const names = dbInserts.filter(i => i.table === "PLAYERS").map(i => i.data.name);
            expect(names).toContain("BotAccount");
        });
    });

    it("when engine.start() throws, the bot resigns on Lichess and cleans up", async () => {
        const failing = new MockEngine();
        failing.start = mock(async () => { throw new Error("spawn failed"); });
        const failBot = new LichessBot("fake_token", () => failing);

        let resignCalled = false;
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: "fail_game" } }]) };
            if (url.includes("/bot/game/fail_game/resign")) { resignCalled = true; return { ok: true }; }
            if (url.includes("/bot/game/stream/")) return { ok: true, body: createMockStream([]) };
            return { ok: false };
        });

        await failBot.start();
        await waitFor(() => expect(resignCalled).toBe(true));
        await waitFor(() => expect(failBot.activeGames.size).toBe(0));
        failBot.stop();
    });

    it("when engine emits fatal_error mid-game, the bot resigns on Lichess and cleans up", async () => {
        const gameId = "fatal_test";
        let streamCtrl;
        let resignCalled = false;

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) {
                return {
                    ok: true,
                    body: new ReadableStream({
                        start(c) {
                            streamCtrl = c;
                            const enc = new TextEncoder();
                            c.enqueue(enc.encode(JSON.stringify(makeGameFull(gameId, "bot", { white: "opp", black: "bot" })) + "\n"));
                        },
                    }),
                };
            }
            if (url.includes(`/bot/game/${gameId}/resign`)) { resignCalled = true; return { ok: true }; }
            return { ok: false };
        });

        await bot.start();
        await waitFor(() => expect(bot.activeGames.has(gameId)).toBe(true));

        engine.emit("fatal_error", new Error("engine died"));

        await waitFor(() => expect(resignCalled).toBe(true));
        await waitFor(() => expect(bot.activeGames.has(gameId)).toBe(false));
    });

    it("isolates engine state across concurrent games (each engine gets its own moves)", async () => {
        const engines = [];
        const seenByEngine = new Map();
        const factory = () => {
            const e = new MockEngine();
            engines.push(e);
            seenByEngine.set(e, []);
            e.position = mock(async (fen, moves) => { seenByEngine.get(e).push(moves.join(",")); });
            return e;
        };
        const isoBot = new LichessBot("fake_token", factory, { maxConcurrentGames: 4 });

        const gameIds = ["isoA", "isoB"];
        const movesByGame = { isoA: "e2e4 e7e5", isoB: "d2d4 d7d5" };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) {
                return { ok: true, body: createMockStream(gameIds.map(id => ({ type: "gameStart", game: { id } }))) };
            }
            for (const id of gameIds) {
                if (url.includes(`/bot/game/stream/${id}`)) {
                    return { ok: true, body: createMockStream([makeGameFull(id, "bot", { moves: movesByGame[id] })]) };
                }
            }
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await isoBot.start();
        await waitFor(() => expect(engines.length).toBe(2));
        await waitFor(() => {
            for (const e of engines) expect(seenByEngine.get(e).length).toBeGreaterThan(0);
        });

        const allMoveSets = engines.map(e => seenByEngine.get(e).join("|")).sort();
        expect(allMoveSets).toEqual(["d2d4,d7d5", "e2e4,e7e5"]);

        isoBot.stop();
    });
});

describe("isMyTurn — custom FEN", () => {
    it("FEN black-to-move with 0 plies: bot=black returns true", () => {
        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        expect(bot.isMyTurn(fen, "", "black")).toBe(true);
        expect(bot.isMyTurn(fen, "", "white")).toBe(false);
    });
    it("FEN black-to-move with 1 ply: bot=white returns true", () => {
        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        expect(bot.isMyTurn(fen, "e7e5", "white")).toBe(true);
        expect(bot.isMyTurn(fen, "e7e5", "black")).toBe(false);
    });
    it("malformed FEN with no color part defaults to white-to-move", () => {
        expect(bot.isMyTurn("badfen", "", "white")).toBe(true);
        expect(bot.isMyTurn("badfen", "", "black")).toBe(false);
    });
    it("whitespace-only movesStr counts as zero moves", () => {
        expect(bot.isMyTurn("startpos", "   ", "white")).toBe(true);
    });
});

describe("sendMove rejected", () => {
    it("returns false (and does not throw) when Lichess rejects the move", async () => {
        global.fetch = mock(async () => ({ ok: false, text: async () => "illegal move" }));
        await expect(bot.sendMove("g1", "e2e5")).resolves.toBe(false);
    });

    it("returns true when Lichess accepts the move", async () => {
        global.fetch = mock(async () => ({ ok: true }));
        await expect(bot.sendMove("g1", "e2e4")).resolves.toBe(true);
    });
});

describe("resignGame silent catch", () => {
    it("does not throw when fetch fails", async () => {
        global.fetch = mock(async () => { throw new Error("network"); });
        await expect(bot.resignGame("g1")).resolves.toBeUndefined();
    });
});

describe("Challenge creators — error paths", () => {
    it("createChallenge throws when Lichess returns non-OK", async () => {
        global.fetch = mock(async () => ({ ok: false, text: async () => "user not found" }));
        await expect(bot.createChallenge("ghost", 60, 0)).rejects.toThrow("user not found");
    });
    it("createOpenChallenge throws when Lichess returns non-OK", async () => {
        global.fetch = mock(async () => ({ ok: false, text: async () => "rate limited" }));
        await expect(bot.createOpenChallenge(60, 0)).rejects.toThrow("rate limited");
    });
    it("createAiChallenge throws when Lichess returns non-OK", async () => {
        global.fetch = mock(async () => ({ ok: false, text: async () => "bad level" }));
        await expect(bot.createAiChallenge(99, 60, 0)).rejects.toThrow("bad level");
    });
});

describe("cancelChallenge", () => {
    it("POSTs to the cancel endpoint", async () => {
        let cancelled = false;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/api/challenge/abc/cancel")) { cancelled = true; return { ok: true }; }
            return { ok: false };
        });
        await bot.cancelChallenge("abc");
        expect(cancelled).toBe(true);
    });
    it("silently swallows fetch errors", async () => {
        global.fetch = mock(async () => { throw new Error("net"); });
        await expect(bot.cancelChallenge("abc")).resolves.toBeUndefined();
    });
});

describe("huntWeakestBot", () => {
    function makeHuntBot() {
        const b = new LichessBot("fake_token", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50 });
        b.botProfile = "self";
        return b;
    }

    it("throws when /bot/online fetch fails", async () => {
        global.fetch = mock(async () => ({ ok: false, statusText: "503" }));
        const b = makeHuntBot();
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("Failed to fetch online bots");
    });

    it("throws when no bots have a blitz rating", async () => {
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([{ id: "x", username: "X", perfs: {} }]) };
            }
            return { ok: false };
        });
        const b = makeHuntBot();
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("No candidates");
    });

    it("excludes self from candidates", async () => {
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([
                    { id: "self", username: "Self", perfs: { blitz: { rating: 800 } } },
                    { id: "other", username: "Other", perfs: { blitz: { rating: 1500 } } },
                ])};
            }
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeHuntBot();
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("Hunt failed");
        expect(tried).not.toContain("Self");
        expect(tried).toContain("Other");
    });

    it("challenges weakest first (ascending blitz rating)", async () => {
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([
                    { id: "s", username: "Strong", perfs: { blitz: { rating: 2000 } } },
                    { id: "w", username: "Weak",   perfs: { blitz: { rating: 1000 } } },
                    { id: "m", username: "Mid",    perfs: { blitz: { rating: 1500 } } },
                ])};
            }
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeHuntBot();
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow();
        expect(tried).toEqual(["Weak", "Mid"]);
    });

    it("returns success when a game shows up in activeGames during polling", async () => {
        let huntBotRef;
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([{ id: "w", username: "Weak", perfs: { blitz: { rating: 1000 } } }]) };
            }
            if (url.includes("/api/challenge/Weak")) {
                setTimeout(() => { huntBotRef.activeGames.add("cWeak"); }, 2);
                return { ok: true, json: async () => ({ id: "cWeak" }) };
            }
            return { ok: false };
        });
        huntBotRef = makeHuntBot();
        const result = await huntBotRef.huntWeakestBot(60, 0);
        expect(result.status).toBe("success");
        expect(result.gameId).toBe("cWeak");
        expect(result.message).toContain("Weak");
    });

    it("skips a candidate when its challenge fetch returns non-OK", async () => {
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([
                    { id: "a", username: "A", perfs: { blitz: { rating: 1000 } } },
                    { id: "b", username: "B", perfs: { blitz: { rating: 1500 } } },
                ])};
            }
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m === null) {
                if (url.includes("/cancel")) return { ok: true };
                return { ok: false };
            }
            tried.push(m[1]);
            if (m[1] === "A") return { ok: false };
            return { ok: true, json: async () => ({ id: "c" + m[1] }) };
        });
        const b = makeHuntBot();
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow();
        expect(tried).toEqual(["A", "B"]);
    });

    it("cancels challenge after 5 missed polls and tries next candidate", async () => {
        let cancelled = false;
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([
                    { id: "a", username: "A", perfs: { blitz: { rating: 1000 } } },
                    { id: "b", username: "B", perfs: { blitz: { rating: 1500 } } },
                ])};
            }
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) { cancelled = true; return { ok: true }; }
            return { ok: false };
        });
        const b = makeHuntBot();
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("Hunt failed");
        expect(cancelled).toBe(true);
        expect(tried).toEqual(["A", "B"]);
    });

    it("rated=false is included in the challenge body", async () => {
        let bodyCaptured;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([{ id: "w", username: "Weak", perfs: { blitz: { rating: 1000 } } }]) };
            }
            if (url.includes("/api/challenge/Weak")) { bodyCaptured = opts?.body?.toString(); return { ok: true, json: async () => ({ id: "x" }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeHuntBot();
        await expect(b.huntWeakestBot(60, 0, false)).rejects.toThrow();
        expect(bodyCaptured).toContain("rated=false");
    });
});

describe("readNdjsonStream", () => {
    function streamFromChunks(chunks) {
        const enc = new TextEncoder();
        return new ReadableStream({
            start(c) {
                for (const chunk of chunks) c.enqueue(enc.encode(chunk));
                c.close();
            },
        });
    }

    it("buffers a JSON line split across two chunks", async () => {
        const stream = streamFromChunks([`{"type":"chal`, `lenge","id":"x"}\n`]);
        const got = [];
        await bot.readNdjsonStream(stream, null, (o) => got.push(o));
        expect(got).toEqual([{ type: "challenge", id: "x" }]);
    });

    it("logs but continues past an invalid JSON line", async () => {
        const stream = streamFromChunks([`{"valid":1}\nnot-json\n{"valid":2}\n`]);
        const got = [];
        await bot.readNdjsonStream(stream, null, (o) => got.push(o));
        expect(got).toEqual([{ valid: 1 }, { valid: 2 }]);
    });

    it("skips empty and whitespace-only lines", async () => {
        const stream = streamFromChunks([`\n\n   \n{"x":1}\n\n{"y":2}\n`]);
        const got = [];
        await bot.readNdjsonStream(stream, null, (o) => got.push(o));
        expect(got).toEqual([{ x: 1 }, { y: 2 }]);
    });

    it("processes multiple JSON objects from one chunk", async () => {
        const stream = streamFromChunks([`{"a":1}\n{"b":2}\n{"c":3}\n`]);
        const got = [];
        await bot.readNdjsonStream(stream, null, (o) => got.push(o));
        expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it("returns when the abort signal fires (cancels the reader)", async () => {
        const ctrl = new AbortController();
        let enq;
        const stream = new ReadableStream({
            start(c) { enq = c; c.enqueue(new TextEncoder().encode(`{"a":1}\n`)); },
        });
        const got = [];
        const p = bot.readNdjsonStream(stream, ctrl.signal, (o) => got.push(o));
        await new Promise(r => setTimeout(r, 20));
        ctrl.abort();
        await p;
        expect(got).toEqual([{ a: 1 }]);
    });
});

describe("stop() — engine teardown and restart", () => {
    it("calls engine.stop() on every gameEngine when bot.stop() is called", () => {
        const e1 = new MockEngine();
        const e2 = new MockEngine();
        bot.gameEngines.set("g1", e1);
        bot.gameEngines.set("g2", e2);

        bot.stop();

        expect(e1.stop).toHaveBeenCalled();
        expect(e2.stop).toHaveBeenCalled();
        expect(bot.gameEngines.size).toBe(0);
    });

    it("can be restarted cleanly after stop()", async () => {
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([]) };
            return { ok: false };
        });
        await bot.start();
        expect(bot.eventController).not.toBeNull();
        bot.stop();
        expect(bot.eventController).toBeNull();
        await bot.start();
        expect(bot.eventController).not.toBeNull();
    });
});

describe("streamEvents() reconnect", () => {
    it("retries the event stream after a non-OK response", async () => {
        const reconnectBot = new LichessBot("fake_token", () => engine, { reconnectDelayMs: 5 });
        let eventAttempts = 0;
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) {
                eventAttempts++;
                if (eventAttempts === 1) return { ok: false, statusText: "Service Unavailable" };
                return { ok: true, body: createMockStream([]) };
            }
            return { ok: false };
        });
        await reconnectBot.start();
        await waitFor(() => expect(eventAttempts).toBeGreaterThanOrEqual(2), 1000);
        reconnectBot.stop();
    });

    it("retries the event stream after an unexpected throw (network error)", async () => {
        const reconnectBot = new LichessBot("fake_token", () => engine, { reconnectDelayMs: 5 });
        let eventAttempts = 0;
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) {
                eventAttempts++;
                if (eventAttempts === 1) throw new Error("connection refused");
                return { ok: true, body: createMockStream([]) };
            }
            return { ok: false };
        });
        await reconnectBot.start();
        await waitFor(() => expect(eventAttempts).toBeGreaterThanOrEqual(2), 1000);
        reconnectBot.stop();
    });

    it("does not reconnect after an AbortError (intentional stop)", async () => {
        const reconnectBot = new LichessBot("fake_token", () => engine, { reconnectDelayMs: 5 });
        let eventAttempts = 0;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) {
                eventAttempts++;
                // Return a stream that listens for abort
                return {
                    ok: true,
                    body: new ReadableStream({
                        start(c) {
                            opts?.signal?.addEventListener("abort", () => {
                                const err = new Error("aborted");
                                err.name = "AbortError";
                                c.error(err);
                            });
                        },
                    }),
                };
            }
            return { ok: false };
        });
        await reconnectBot.start();
        await new Promise(r => setTimeout(r, 20));
        reconnectBot.stop();
        const before = eventAttempts;
        await new Promise(r => setTimeout(r, 50));
        expect(eventAttempts).toBe(before);
    });
});

describe("Concurrent games — fault isolation", () => {
    it("one game's engine emitting fatal_error does NOT affect other games", async () => {
        const engines = [];
        const factory = () => {
            const e = new MockEngine();
            engines.push(e);
            return e;
        };
        const bot2 = new LichessBot("fake_token", factory, { maxConcurrentGames: 4 });

        const streamCtrls = {};
        const resignedGames = new Set();

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) {
                return { ok: true, body: createMockStream([
                    { type: "gameStart", game: { id: "gA" } },
                    { type: "gameStart", game: { id: "gB" } },
                ])};
            }
            for (const id of ["gA", "gB"]) {
                if (url.includes(`/bot/game/stream/${id}`)) {
                    return { ok: true, body: new ReadableStream({
                        start(c) {
                            streamCtrls[id] = c;
                            const enc = new TextEncoder();
                            c.enqueue(enc.encode(JSON.stringify(makeGameFull(id, "bot", { white: "opp", black: "bot" })) + "\n"));
                        },
                    })};
                }
                if (url.includes(`/bot/game/${id}/resign`)) { resignedGames.add(id); return { ok: true }; }
            }
            return { ok: false };
        });

        await bot2.start();
        await waitFor(() => expect(bot2.activeGames.size).toBe(2));
        await waitFor(() => expect(engines.length).toBe(2));

        engines[0].emit("fatal_error", new Error("A died"));

        await waitFor(() => expect(bot2.activeGames.has("gA")).toBe(false));
        expect(bot2.activeGames.has("gB")).toBe(true);
        expect(resignedGames.has("gA")).toBe(true);
        expect(resignedGames.has("gB")).toBe(false);

        bot2.stop();
    });
});

describe("playGame — engine.stop() failure", () => {
    it("still cleans up activeGames / gameEngines if engine.stop() rejects in finally", async () => {
        const flakyEngine = new MockEngine();
        flakyEngine.stop = mock(async () => { throw new Error("stop crashed"); });
        const flakyBot = new LichessBot("fake_token", () => flakyEngine);

        const gameId = "stop_fail";
        const endingState = {
            type: "gameState",
            moves: "e2e4",
            wtime: 60000, btime: 60000, winc: 0, binc: 0,
            status: "mate",
            winner: "white",
        };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([
                makeGameFull(gameId, "bot", { white: "opp", black: "bot" }),
                endingState,
            ])};
            return { ok: false };
        });

        await flakyBot.start();
        await waitFor(() => expect(flakyBot.activeGames.has(gameId)).toBe(false));
        expect(flakyBot.gameEngines.has(gameId)).toBe(false);
        expect(flakyBot.gameControllers.has(gameId)).toBe(false);
        flakyBot.stop();
    });
});

describe("playGame — missing variant defaults to 'standard'", () => {
    it("createDbGame receives variant='standard' when obj.variant is entirely missing", async () => {
        const gameId = "no_variant";
        const gf = makeGameFull(gameId, "bot");
        delete gf.variant;
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => {
            const gi = dbInserts.find(i => i.table === "GAMES");
            expect(gi).toBeDefined();
            expect(gi.data.variant).toBe("standard");
        });
    });

    it("createDbGame receives variant='standard' when obj.variant.key is missing", async () => {
        const gameId = "empty_variant";
        const gf = makeGameFull(gameId, "bot");
        gf.variant = {};
        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });
        await bot.start();
        await waitFor(() => {
            const gi = dbInserts.find(i => i.table === "GAMES");
            expect(gi).toBeDefined();
            expect(gi.data.variant).toBe("standard");
        });
    });
});

describe("huntWeakestBot — extra coverage", () => {
    it("slices to top 2 candidates even when more eligible bots exist", async () => {
        const bots = Array.from({ length: 15 }, (_, i) => ({
            id: `b${i}`, username: `Bot${i}`,
            perfs: { blitz: { rating: 1000 + i * 10 } },
        }));
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = new LichessBot("fake_token", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50 });
        b.botProfile = "self";
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("Hunt failed");
        expect(tried).toHaveLength(2);
        // 2 weakest = Bot0..Bot1
        expect(tried).toEqual(["Bot0", "Bot1"]);
    });

    it("continues to next candidate when a challenge fetch THROWS (network)", async () => {
        const bots = [
            { id: "a", username: "A", perfs: { blitz: { rating: 1000 } } },
            { id: "b", username: "B", perfs: { blitz: { rating: 1500 } } },
        ];
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) {
                tried.push(m[1]);
                if (m[1] === "A") throw new Error("ECONNRESET");
                return { ok: true, json: async () => ({ id: "cB" }) };
            }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = new LichessBot("fake_token", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50 });
        b.botProfile = "self";
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("Hunt failed");
        expect(tried).toEqual(["A", "B"]);
    });
});

describe("Hunt decline cool-down", () => {
    it("_markDeclined + _inDeclineCooldown round-trip", () => {
        const b = new LichessBot("t", () => engine, { declineCooldownMs: 60_000 });
        expect(b._inDeclineCooldown("Foo")).toBe(false);
        b._markDeclined("Foo");
        expect(b._inDeclineCooldown("Foo")).toBe(true);
        expect(b._inDeclineCooldown("foo")).toBe(true); // case-insensitive
    });

    it("_pruneDeclined removes expired entries", () => {
        const b = new LichessBot("t", () => engine, { declineCooldownMs: 60_000 });
        b.recentlyDeclined.set("expired", Date.now() - 1);
        b.recentlyDeclined.set("fresh", Date.now() + 60_000);
        b._pruneDeclined();
        expect(b.recentlyDeclined.has("expired")).toBe(false);
        expect(b.recentlyDeclined.has("fresh")).toBe(true);
    });

    it("huntWeakestBot skips bots already in cool-down", async () => {
        const bots = [
            { id: "a", username: "A", perfs: { blitz: { rating: 1000 } } },
            { id: "b", username: "B", perfs: { blitz: { rating: 1500 } } },
            { id: "c", username: "C", perfs: { blitz: { rating: 2000 } } },
        ];
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50, declineCooldownMs: 60_000 });
        b.botProfile = "self";
        b._markDeclined("A");
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("Hunt failed");
        expect(tried).not.toContain("A");
        expect(tried).toContain("B");
        expect(tried).toContain("C");
    });

    it("huntWeakestBot marks bots that ignore the challenge", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1000 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) return { ok: true, json: async () => ({ id: "cA" }) };
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50, declineCooldownMs: 60_000 });
        b.botProfile = "self";
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow("Hunt failed");
        expect(b._inDeclineCooldown("A")).toBe(true);
    });

    it("huntWeakestBot marks bots when challenge POST returns non-OK", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1000 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) return { ok: false };
            return { ok: false };
        });
        const b = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50, declineCooldownMs: 60_000 });
        b.botProfile = "self";
        await expect(b.huntWeakestBot(60, 0)).rejects.toThrow();
        expect(b._inDeclineCooldown("A")).toBe(true);
    });

    it("huntWeakestBot does NOT mark a bot that accepts (game appears in activeGames)", async () => {
        let botRef;
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([{ id: "a", username: "A", perfs: { blitz: { rating: 1000 } } }]) };
            }
            if (url.match(/\/api\/challenge\/A$/)) {
                setTimeout(() => { botRef.activeGames.add("cA"); }, 2);
                return { ok: true, json: async () => ({ id: "cA" }) };
            }
            return { ok: false };
        });
        botRef = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50, declineCooldownMs: 60_000 });
        botRef.botProfile = "self";
        const result = await botRef.huntWeakestBot(60, 0);
        expect(result.status).toBe("success");
        expect(botRef._inDeclineCooldown("A")).toBe(false);
    });

    it("default cool-down is 15 minutes", () => {
        const b = new LichessBot("t", () => engine);
        expect(b.declineCooldownMs).toBe(15 * 60 * 1000);
    });
});

// Helper: standard rating-stream + account mock for huntNearRating tests.
function mockNearRatingFetch(myRating, bots) {
    return mock(async (url) => {
        if (url.includes("/api/account")) {
            return { ok: true, json: async () => ({ perfs: { blitz: { rating: myRating } } }) };
        }
        if (url.includes("/bot/online")) {
            return { ok: true, body: createMockStream(bots) };
        }
        const m = url.match(/\/api\/challenge\/([^/]+)$/);
        if (m) {
            // Default: bot ignores us (cancelable). Tests override per-username via tried-list.
            return { ok: true, json: async () => ({ id: "c" + m[1] }) };
        }
        if (url.includes("/cancel")) return { ok: true };
        return { ok: false };
    });
}

describe("huntNearRating — auto-widen window", () => {
    function makeBot(opts = {}) {
        const b = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50, ...opts });
        b.botProfile = "self";
        return b;
    }

    it("uses the initial window when it has candidates (does NOT widen)", async () => {
        const bots = [
            { id: "near", username: "Near",  perfs: { blitz: { rating: 1850 } } }, // Δ50
            { id: "far",  username: "Far",   perfs: { blitz: { rating: 2500 } } }, // Δ700
        ];
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeBot();
        await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 2000 })).rejects.toThrow("Hunt failed");
        expect(tried).toEqual(["Near"]);
        expect(tried).not.toContain("Far");
    });

    it("widens window when initial pool is empty", async () => {
        const bots = [
            { id: "x", username: "X", perfs: { blitz: { rating: 2400 } } }, // Δ600 — outside ±200, inside ±800
        ];
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeBot();
        await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 2000 })).rejects.toThrow("Hunt failed");
        expect(tried).toEqual(["X"]); // found after widening
    });

    it("widens when initial pool is empty only due to cool-down", async () => {
        const bots = [
            { id: "n", username: "Near", perfs: { blitz: { rating: 1850 } } }, // Δ50, but cooled-down
            { id: "f", username: "Far",  perfs: { blitz: { rating: 2400 } } }, // Δ600, outside ±200
        ];
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeBot({ declineCooldownMs: 60_000 });
        b._markDeclined("Near");
        await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 2000 })).rejects.toThrow("Hunt failed");
        expect(tried).not.toContain("Near"); // still in cool-down at every window
        expect(tried).toEqual(["Far"]);        // found via widening
    });

    it("stops widening at maxWindow and throws if still empty", async () => {
        const bots = [
            { id: "f", username: "Far", perfs: { blitz: { rating: 5000 } } }, // Δ3200, outside maxWindow=2000
        ];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            return { ok: false };
        });
        const b = makeBot();
        await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 2000 })).rejects.toThrow(/none within ±2000/);
    });

    it("throws with cool-down reason when every bot at maxWindow is cooled-down", async () => {
        const bots = [
            { id: "a", username: "A", perfs: { blitz: { rating: 1820 } } },
            { id: "b", username: "B", perfs: { blitz: { rating: 1900 } } },
        ];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            return { ok: false };
        });
        const b = makeBot({ declineCooldownMs: 60_000 });
        b._markDeclined("A");
        b._markDeclined("B");
        await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 2000 })).rejects.toThrow(/in cool-down/);
    });

    it("widens past one level when one widen step is still not enough", async () => {
        // myRating=1800; only bot is Δ1500 → needs widening to ±1600 (200→400→800→1600).
        const bots = [{ id: "x", username: "X", perfs: { blitz: { rating: 3300 } } }];
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { tried.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeBot();
        await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 2000 })).rejects.toThrow("Hunt failed");
        expect(tried).toEqual(["X"]);
    });

    it("respects maxWindow=window (no widening allowed)", async () => {
        const bots = [{ id: "x", username: "X", perfs: { blitz: { rating: 2400 } } }]; // Δ600
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            return { ok: false };
        });
        const b = makeBot();
        // window === maxWindow disables widening
        await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 200 })).rejects.toThrow(/none within ±200/);
    });

    it("clamps an initial window > maxWindow down to maxWindow", async () => {
        const bots = [{ id: "x", username: "X", perfs: { blitz: { rating: 2400 } } }]; // Δ600
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            return { ok: false };
        });
        const b = makeBot();
        // window=5000 > maxWindow=500. Should clamp to 500, so Δ600 stays out.
        await expect(b.huntNearRating(180, 2, true, { window: 5000, maxWindow: 500 })).rejects.toThrow(/none within ±500/);
    });

    it("succeeds (returns gameId) when widening produces a bot that accepts", async () => {
        let botRef;
        const bots = [{ id: "x", username: "X", perfs: { blitz: { rating: 2400 } } }]; // outside ±200, inside ±800
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/X$/)) {
                setTimeout(() => { botRef.activeGames.add("cX"); }, 2);
                return { ok: true, json: async () => ({ id: "cX" }) };
            }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        botRef = makeBot();
        const result = await botRef.huntNearRating(180, 2, true, { window: 200, maxWindow: 2000 });
        expect(result.status).toBe("success");
        expect(result.gameId).toBe("cX");
    });

    it("does NOT widen past maxWindow even if pool stays empty after multiple doublings", async () => {
        // Track windows tried via notifier.info spying.
        const widenLogs = [];
        try {
            global.fetch = mock(async (url) => {
                if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
                if (url.includes("/bot/online")) return { ok: true, body: createMockStream([]) };
                return { ok: false };
            });
            const b = makeBot();
            const origInfo = b.notifier.info.bind(b.notifier);
            b.notifier.info = (...args) => {
                const line = args.join(" ");
                if (line.includes("widening to")) widenLogs.push(line);
                origInfo(...args);
            };
            await expect(b.huntNearRating(180, 2, true, { window: 200, maxWindow: 1600 })).rejects.toThrow();
            // 200 → 400 → 800 → 1600 (cap). Three widen messages.
            expect(widenLogs.length).toBe(3);
            expect(widenLogs[widenLogs.length - 1]).toContain("±1600");
        } finally {
        }
    });
});

describe("Lichess 429 rate-limit handling", () => {
    function makeBot(opts = {}) {
        const b = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50, ...opts });
        b.botProfile = "self";
        return b;
    }

    it("huntNearRating: 429 throws LichessRateLimited with Retry-After value", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1820 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) return rateLimitResponse(42);
            return { ok: false };
        });
        const b = makeBot();
        await expect(b.huntNearRating(180, 0, true)).rejects.toBeInstanceOf(LichessRateLimited);
        try { await b.huntNearRating(180, 0, true); }
        catch (err) { expect(err.retryAfterSec).toBe(42); }
    });

    it("huntNearRating: 429 does NOT mark target as declined", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1820 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) return rateLimitResponse(30);
            return { ok: false };
        });
        const b = makeBot();
        await expect(b.huntNearRating(180, 0, true)).rejects.toBeInstanceOf(LichessRateLimited);
        // Bot must remain challengeable on the next hunt.
        expect(b._inDeclineCooldown("A")).toBe(false);
    });

    it("huntNearRating: 429 aborts immediately, does NOT challenge remaining candidates", async () => {
        const bots = [
            { id: "a", username: "A", perfs: { blitz: { rating: 1810 } } },
            { id: "b", username: "B", perfs: { blitz: { rating: 1820 } } },
            { id: "c", username: "C", perfs: { blitz: { rating: 1830 } } },
        ];
        const tried = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) {
                tried.push(m[1]);
                if (m[1] === "A") return { ok: true, json: async () => ({ id: "cA" }) };
                return rateLimitResponse(30); // B trips the limit
            }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeBot();
        // The pool is shuffled, so we can't predict which bot trips it. Just
        // verify: after a 429, the loop stops (tried.length <= position of 429).
        await expect(b.huntNearRating(180, 0, true, { maxAttempts: 3 })).rejects.toBeInstanceOf(LichessRateLimited);
        expect(tried.length).toBeLessThanOrEqual(3);
        // No bot should be in cool-down (we either accepted them, or got 429).
        expect(b.recentlyDeclined.size).toBe(0);
    });

    it("huntNearRating: uses defaultRetryAfterSec when 429 response has no Retry-After header", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1820 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) return rateLimitResponse(null); // no header
            return { ok: false };
        });
        const b = makeBot({ defaultRetryAfterSec: 90 });
        try { await b.huntNearRating(180, 0, true); }
        catch (err) {
            expect(err).toBeInstanceOf(LichessRateLimited);
            expect(err.retryAfterSec).toBe(90);
        }
    });

    it("huntNearRating: ignores malformed Retry-After header, falls back to default", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1820 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) {
                const headers = new Headers();
                headers.set("Retry-After", "garbage");
                return { ok: false, status: 429, headers, text: async () => "" };
            }
            return { ok: false };
        });
        const b = makeBot({ defaultRetryAfterSec: 75 });
        try { await b.huntNearRating(180, 0, true); }
        catch (err) { expect(err.retryAfterSec).toBe(75); }
    });

    it("huntNearRating: still marks 400-level non-429 rejects as declined", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1820 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) {
                return { ok: false, status: 400, headers: new Headers(), text: async () => '{"error":"Invalid time control"}' };
            }
            return { ok: false };
        });
        const b = makeBot();
        await expect(b.huntNearRating(180, 0, true)).rejects.toThrow("Hunt failed");
        expect(b._inDeclineCooldown("A")).toBe(true);
    });

    it("huntWeakestBot: 429 throws LichessRateLimited and does not mark declined", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1000 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) return rateLimitResponse(25);
            return { ok: false };
        });
        const b = makeBot();
        try { await b.huntWeakestBot(60, 0); }
        catch (err) {
            expect(err).toBeInstanceOf(LichessRateLimited);
            expect(err.retryAfterSec).toBe(25);
        }
        expect(b._inDeclineCooldown("A")).toBe(false);
    });

    it("inter-challenge spacing: waits configured ms between successive challenges", async () => {
        const bots = [
            { id: "a", username: "A", perfs: { blitz: { rating: 1810 } } },
            { id: "b", username: "B", perfs: { blitz: { rating: 1820 } } },
        ];
        let lastChallengeTs = 0;
        const gaps = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) {
                const now = Date.now();
                if (lastChallengeTs > 0) gaps.push(now - lastChallengeTs);
                lastChallengeTs = now;
                return { ok: true, json: async () => ({ id: "c" + m[1] }) };
            }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });
        const b = makeBot({ apiSpacingMs: 0, challengeSpacingMs: 80 });
        await expect(b.huntNearRating(180, 0, true, { maxAttempts: 2 })).rejects.toThrow("Hunt failed");
        expect(gaps.length).toBeGreaterThanOrEqual(1);
        // Allow some scheduler slop; we just want to confirm the delay fired.
        for (const g of gaps) expect(g).toBeGreaterThanOrEqual(70);
    });

    it("LichessRateLimited carries the name and retryAfterSec", () => {
        const err = new LichessRateLimited(42);
        expect(err.name).toBe("LichessRateLimited");
        expect(err.retryAfterSec).toBe(42);
        expect(err.message).toContain("42");
    });
});

describe("Autoplay respects LichessRateLimited backoff", () => {
    it("uses Retry-After (in ms + buffer) instead of exponential backoff", async () => {
        const bots = [{ id: "a", username: "A", perfs: { blitz: { rating: 1820 } } }];
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: true, body: createMockStream(bots) };
            if (url.match(/\/api\/challenge\/A$/)) return rateLimitResponse(30);
            return { ok: false };
        });
        const b = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50 });
        b.botProfile = "self";
        b.autoplay = { limit: 180, increment: 0, rated: true, target: 1, mode: "near", window: 200, currentBackoffMs: 0, huntInFlight: false, timer: null };

        // Trigger one tick; tickAutoplay schedules itself via setTimeout — we
        // just need to see currentBackoffMs after the hunt rejects.
        b._tickAutoplay();
        // Wait long enough for the hunt to throw and the catch handler to run.
        await new Promise(r => setTimeout(r, 100));

        // Expected: 30s * 1000 + 500ms buffer = 30500.
        expect(b.autoplay?.currentBackoffMs).toBe(30_500);

        // Cleanup so the scheduled timer doesn't fire after the test.
        b.stopAutoplay();
    });

    it("non-429 errors still use exponential backoff starting at 30s", async () => {
        global.fetch = mock(async (url) => {
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ perfs: { blitz: { rating: 1800 } } }) };
            if (url.includes("/bot/online")) return { ok: false, statusText: "503" };
            return { ok: false };
        });
        const b = new LichessBot("t", () => engine, { huntPollIntervalMs: 1, apiSpacingMs: 0, challengeSpacingMs: 0, huntAcceptTimeoutMs: 50 });
        b.botProfile = "self";
        b.autoplay = { limit: 180, increment: 0, rated: true, target: 1, mode: "near", window: 200, currentBackoffMs: 0, huntInFlight: false, timer: null };

        b._tickAutoplay();
        await new Promise(r => setTimeout(r, 50));

        // First failure: 30s
        expect(b.autoplay?.currentBackoffMs).toBe(30_000);
        b.stopAutoplay();
    });
});


describe("createChallenge — extra coverage", () => {
    it("rated=false is included in the body", async () => {
        let body;
        global.fetch = mock(async (url, opts) => {
            if (url.includes("/api/challenge/opp")) { body = opts?.body?.toString(); return { ok: true, json: async () => ({ id: "x" }) }; }
            return { ok: false };
        });
        await bot.createChallenge("opp", 60, 0, false);
        expect(body).toContain("rated=false");
    });
});

describe("readNdjsonStream — callback errors", () => {
    it("logs and continues when the callback itself throws", async () => {
        const stream = new ReadableStream({
            start(c) {
                const enc = new TextEncoder();
                c.enqueue(enc.encode(`{"x":1}\n{"x":2}\n{"x":3}\n`));
                c.close();
            },
        });

        let calls = 0;
        await bot.readNdjsonStream(stream, null, (o) => {
            calls++;
            if (o.x === 2) throw new Error("callback boom");
        });

        expect(calls).toBe(3);
    });
});

describe("saveNewMoves — progressive multi-event sequence", () => {
    it("appends exactly the new moves across 3 sequential gameState events", async () => {
        const gameId = "progressive";

        const gf = makeGameFull(gameId, "bot", { white: "opp", black: "bot", moves: "" });
        const gs1 = { type: "gameState", moves: "e2e4",                wtime: 60000, btime: 60000, winc: 0, binc: 0, status: "started" };
        const gs2 = { type: "gameState", moves: "e2e4 e7e5",           wtime: 60000, btime: 60000, winc: 0, binc: 0, status: "started" };
        const gs3 = { type: "gameState", moves: "e2e4 e7e5 g1f3",      wtime: 60000, btime: 60000, winc: 0, binc: 0, status: "started" };

        global.fetch = mock(async (url) => {
            if (url.includes("/account")) return { ok: true, json: async () => ({ id: "bot" }) };
            if (url.includes("/stream/event")) return { ok: true, body: createMockStream([{ type: "gameStart", game: { id: gameId } }]) };
            if (url.includes(`/bot/game/stream/${gameId}`)) return { ok: true, body: createMockStream([gf, gs1, gs2, gs3]) };
            if (url.includes("/move/")) return { ok: true };
            return { ok: false };
        });

        await bot.start();
        await waitFor(() => {
            const flat = dbInserts.filter(i => i.table === "GAME_MOVES")
                .flatMap(i => Array.isArray(i.data) ? i.data : [i.data]);
            expect(flat.filter(m => m.uci === "g1f3")).toHaveLength(1);
        });

        const flat = dbInserts.filter(i => i.table === "GAME_MOVES")
            .flatMap(i => Array.isArray(i.data) ? i.data : [i.data]);
        // Each move appears exactly once with the right ply
        expect(flat.filter(m => m.ply === 1 && m.uci === "e2e4")).toHaveLength(1);
        expect(flat.filter(m => m.ply === 2 && m.uci === "e7e5")).toHaveLength(1);
        expect(flat.filter(m => m.ply === 3 && m.uci === "g1f3")).toHaveLength(1);
    });
});

describe("Rate limiting — _setRateLimit / _loadRateLimitState", () => {
    it("every new LichessBot instance starts with rateLimitConsecutiveHits=0 (no cross-session bleed)", () => {
        // The consecutive-hit counter must NOT carry over from a previous session.
        // This is guaranteed by the constructor initialising it to 0 and by
        // _loadRateLimitState not restoring it from disk. If either breaks, the
        // multiplier reaches 16× after just 5 restarts while rate-limited.
        const b = new LichessBot("t", () => engine);
        expect(b.rateLimitConsecutiveHits).toBe(0);
        // Even if we manually dirty the counter and create another instance, it starts clean.
        b.rateLimitConsecutiveHits = 99;
        const b2 = new LichessBot("t", () => engine);
        expect(b2.rateLimitConsecutiveHits).toBe(0);
    });

    it("first 429 after recovery gives 1× Retry-After backoff (counter starts at 0)", () => {
        const b = new LichessBot("t", () => engine);
        expect(b.rateLimitConsecutiveHits).toBe(0);
        b._setRateLimit(60);
        expect(b.rateLimitConsecutiveHits).toBe(1);
        // hit #1 → exp=0 → mult=1 → 60s
        expect(b._rateLimitRemainingSec()).toBeGreaterThan(55);
        expect(b._rateLimitRemainingSec()).toBeLessThanOrEqual(60);
    });

    it("backoff doubles each consecutive hit up to the 16× cap", () => {
        const b = new LichessBot("t", () => engine, { rateLimitMaxMultiplier: 16 });
        b._setRateLimit(60); // hit 1 → 60s
        b._setRateLimit(60); // hit 2 → 120s
        b._setRateLimit(60); // hit 3 → 240s
        b._setRateLimit(60); // hit 4 → 480s
        b._setRateLimit(60); // hit 5 → 960s (16×)
        expect(b.rateLimitConsecutiveHits).toBe(5);
        expect(b._rateLimitRemainingSec()).toBeGreaterThan(950);
        expect(b._rateLimitRemainingSec()).toBeLessThanOrEqual(960);
    });

    it("_onSuccessfulPost resets the consecutive-hit counter", () => {
        const b = new LichessBot("t", () => engine);
        b._setRateLimit(60);
        b._setRateLimit(60);
        expect(b.rateLimitConsecutiveHits).toBe(2);
        b._onSuccessfulPost();
        expect(b.rateLimitConsecutiveHits).toBe(0);
    });
});

describe("Challenge spacing — _raceChallenges paces challenge POSTs", () => {
    it("spaces consecutive challenges by at least challengeSpacingMs", async () => {
        const spacing = 100; // use 100ms for test speed
        const b = new LichessBot("fake_token", () => engine, {
            apiSpacingMs: 0, challengeSpacingMs: spacing,
            huntPollIntervalMs: 1,
            huntAcceptTimeoutMs: 10,
        });
        b.botProfile = "self";

        const postTimes = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                return { ok: true, body: createMockStream([
                    { id: "a", username: "A", perfs: { blitz: { rating: 1000 } } },
                    { id: "b", username: "B", perfs: { blitz: { rating: 1100 } } },
                    { id: "c", username: "C", perfs: { blitz: { rating: 1200 } } },
                ])};
            }
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ id: "self", perfs: { blitz: { rating: 1050 } } }) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) {
                postTimes.push(Date.now());
                return { ok: true, json: async () => ({ id: "c" + m[1] }) };
            }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });

        await expect(b.huntNearRating(180, 2)).rejects.toThrow();

        // Every gap between consecutive challenge POSTs should be >= spacing
        for (let i = 1; i < postTimes.length; i++) {
            expect(postTimes[i] - postTimes[i - 1]).toBeGreaterThanOrEqual(spacing - 5); // 5ms tolerance
        }
    });

    it("default challengeSpacingMs is 2000ms", () => {
        const b = new LichessBot("t", () => engine);
        expect(b.challengeSpacingMs).toBe(2000);
    });
});

describe("huntNearRating — maxAttempts default", () => {
    it("challenges at most 2 candidates per hunt by default", async () => {
        const b = new LichessBot("fake_token", () => engine, {
            apiSpacingMs: 0, challengeSpacingMs: 0,
            huntPollIntervalMs: 1,
            huntAcceptTimeoutMs: 10,
        });
        b.botProfile = "self";

        const challenged = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                const bots = Array.from({length: 20}, (_, i) => ({
                    id: `bot${i}`, username: `Bot${i}`,
                    perfs: { blitz: { rating: 1000 + i * 10 } },
                }));
                return { ok: true, body: createMockStream(bots) };
            }
            if (url.includes("/api/account")) return { ok: true, json: async () => ({ id: "self", perfs: { blitz: { rating: 1050 } } }) };
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { challenged.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });

        await expect(b.huntNearRating(180, 2)).rejects.toThrow();
        expect(challenged.length).toBeLessThanOrEqual(2);
    });
});

describe("huntWeakestBot — candidate limit", () => {
    it("challenges at most 2 candidates", async () => {
        const b = new LichessBot("fake_token", () => engine, {
            apiSpacingMs: 0, challengeSpacingMs: 0,
            huntPollIntervalMs: 1,
            huntAcceptTimeoutMs: 10,
        });
        b.botProfile = "self";

        const challenged = [];
        global.fetch = mock(async (url) => {
            if (url.includes("/bot/online")) {
                const bots = Array.from({length: 20}, (_, i) => ({
                    id: `bot${i}`, username: `Bot${i}`,
                    perfs: { blitz: { rating: 1000 + i * 10 } },
                }));
                return { ok: true, body: createMockStream(bots) };
            }
            const m = url.match(/\/api\/challenge\/([^/]+)$/);
            if (m) { challenged.push(m[1]); return { ok: true, json: async () => ({ id: "c" + m[1] }) }; }
            if (url.includes("/cancel")) return { ok: true };
            return { ok: false };
        });

        await expect(b.huntWeakestBot(180, 2)).rejects.toThrow("Hunt failed");
        expect(challenged.length).toBeLessThanOrEqual(2);
    });
});

describe("isMyTurn — deeper plies", () => {
    it("at ply 10 (even) the start-color side is to move", () => {
        const moves = "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7";
        expect(bot.isMyTurn("startpos", moves, "white")).toBe(true);
        expect(bot.isMyTurn("startpos", moves, "black")).toBe(false);
    });
    it("at ply 7 (odd) the opposite-color side is to move", () => {
        const moves = "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4";
        expect(bot.isMyTurn("startpos", moves, "black")).toBe(true);
        expect(bot.isMyTurn("startpos", moves, "white")).toBe(false);
    });
});
