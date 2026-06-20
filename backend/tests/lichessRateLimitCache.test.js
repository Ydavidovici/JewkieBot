import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LichessBot, LichessRateLimited } from "../src/lichessBot.js";
import { nullNotifier } from "../src/notifier.js";

describe("LichessBot - Caching and Throttling", () => {
    let originalFetch;
    let bot;
    let currentTime;

    const advanceTime = (ms) => {
        currentTime += ms;
    };
    
    beforeEach(() => {
        originalFetch = global.fetch;
        global.fetch = mock();
        currentTime = 1000000;
        
        bot = new LichessBot("dummy-token", () => ({}), {
            notifier: nullNotifier,
            challengeSpacingMs: 50, // Keep short for fast tests
            huntAcceptTimeoutMs: 100,
            now: () => currentTime
        });
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("should cache profile fetches for 60 seconds", async () => {
        global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ perfs: { blitz: { rating: 1500 } } }), { status: 200 }));
        
        const r1 = await bot._fetchMyRating("blitz");
        expect(r1.rating).toBe(1500);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Fetching again immediately should use cache
        const r2 = await bot._fetchMyRating("blitz");
        expect(r2.rating).toBe(1500);
        expect(global.fetch).toHaveBeenCalledTimes(1); // Still 1

        // Advance 30 seconds, still cached
        advanceTime(30000);
        const r3 = await bot._fetchMyRating("blitz");
        expect(r3.rating).toBe(1500);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Advance another 31 seconds, cache expires
        advanceTime(31000);
        global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ perfs: { blitz: { rating: 1550 } } }), { status: 200 }));
        
        const r4 = await bot._fetchMyRating("blitz");
        expect(r4.rating).toBe(1550);
        expect(global.fetch).toHaveBeenCalledTimes(2); // Now 2
    });

    it("should cache online bots for 30 seconds", async () => {
        const botsPayload = "{\"id\":\"bot1\",\"username\":\"Bot1\"}\n{\"id\":\"bot2\",\"username\":\"Bot2\"}\n";
        global.fetch.mockResolvedValueOnce(new Response(botsPayload, { status: 200 }));
        
        const b1 = await bot._fetchOnlineBots(500);
        expect(b1.length).toBe(2);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Fetching again should use cache
        const b2 = await bot._fetchOnlineBots(200);
        expect(b2.length).toBe(2);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Advance 15 seconds, still cached
        advanceTime(15000);
        await bot._fetchOnlineBots(500);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Advance 16 seconds, cache expires
        advanceTime(16000);
        global.fetch.mockResolvedValueOnce(new Response("{\"id\":\"bot3\",\"username\":\"Bot3\"}\n", { status: 200 }));
        
        const b3 = await bot._fetchOnlineBots(500);
        expect(b3.length).toBe(1);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should throttle global challenges", async () => {
        // Mock fetch to just return 200 OK so _lichessFetch succeeds
        global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
        
        // No wait on first call
        await bot._throttleGlobalChallenge();
        expect(bot.lastChallengeTime).toBe(currentTime);
        
        // Second call right after should block for 50ms (mocked challengeSpacingMs)
        let resolved = false;
        const p = bot._throttleGlobalChallenge().then(() => { resolved = true; });
        
        // Advance time a little but not enough
        advanceTime(20);
        await new Promise(r => setTimeout(r, 10)); // Yield to event loop
        expect(resolved).toBe(false);
        
        // It shouldn't resolve until the timeout finishes, but since our tests
        // mock Date.now but NOT setTimeout, the actual Promise resolves after
        // the real setTimeout(..., 30) finishes.
        await p;
        expect(resolved).toBe(true);
    });

    it("should globally throttle all API requests to 1000ms", async () => {
        bot.apiSpacingMs = 1000;
        global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
        
        // First API call - should have no delay
        await bot._lichessFetch("https://lichess.org/api/test");
        expect(bot.lastApiTime).toBe(currentTime);

        // Second API call right after
        let resolved = false;
        const p = bot._lichessFetch("https://lichess.org/api/test2").then(() => { resolved = true; });

        // Yield to event loop
        await new Promise(r => setTimeout(r, 10));
        expect(resolved).toBe(false); // blocked by the 1000ms throttle

        // Await the real setTimeout in _lichessFetch (1000ms wall time since we don't mock setTimeout)
        await p;
        expect(resolved).toBe(true);
    });
});
