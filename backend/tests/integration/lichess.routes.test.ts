import {describe, it, expect, beforeEach, afterEach} from "bun:test";
import {createApp} from "../../src/server.ts";
import {nullNotifier} from "../../src/notifier.js";

// Integration tests for the Lichess REST routes. These exercise the real
// Express stack (routing, JSON parsing, the controller, status/error mapping)
// by hitting the assembled app over HTTP. The Lichess/engine/DB boundary is
// faked at the controller's `BotClass` seam, so nothing leaves the process —
// no token, no network, fully deterministic.

// Per-test knobs read by the fake bot so we can script success/failure.
let botState: {
    startThrows?: boolean;
    challengeThrows?: boolean;
    challengeResult?: any;
};

// A stand-in for LichessBot: records the calls the controller makes and returns
// canned values. The controller constructs it via `new BotClass(...)`.
class FakeBot {
    static last: FakeBot | null = null;

    botProfile: string | null = "fakebot";
    activeGames = new Set<string>(["game_a"]);
    recentlyDeclined = new Set<string>(["someBot"]);
    maxConcurrentGames: number;
    autoplay: any = null;
    calls: Record<string, any[][]> = {};

    constructor(_token: string, _factory: any, options: any) {
        this.maxConcurrentGames = options?.maxConcurrentGames ?? 4;
        FakeBot.last = this;
    }

    private rec(name: string, args: any[]) {
        (this.calls[name] ??= []).push(args);
    }

    async start() {
        this.rec("start", []);
        if (botState.startThrows) throw new Error("start failed");
    }
    stop() { this.rec("stop", []); }
    _rateLimitRemainingSec() { return 0; }
    _ensureProfile() { return Promise.resolve(); }

    async createOpenChallenge(...args: any[]) {
        this.rec("createOpenChallenge", args);
        if (botState.challengeThrows) throw new Error("challenge failed");
        return botState.challengeResult ?? {id: "challenge_1"};
    }
    async createAiChallenge(...args: any[]) {
        this.rec("createAiChallenge", args);
        if (botState.challengeThrows) throw new Error("ai challenge failed");
        return botState.challengeResult ?? {id: "ai_1"};
    }
    async huntWeakestBot(...args: any[]) {
        this.rec("huntWeakestBot", args);
        if (botState.challengeThrows) throw new Error("hunt failed");
        return {status: "success", gameId: "g1"};
    }
    startAutoplay(...args: any[]) {
        this.rec("startAutoplay", args);
        this.autoplay = {...args[0], huntInFlight: false, timer: null};
    }
    stopAutoplay() {
        this.rec("stopAutoplay", []);
        this.autoplay = null;
    }
    autoplayStatus() {
        return this.autoplay
            ? {enabled: true, ...this.autoplay, active: this.activeGames.size}
            : {enabled: false};
    }
}

let server: any;
let base: string;

function buildApp(overrides: any = {}) {
    const {app} = createApp({
        getToken: () => "fake-token",
        lichessEngineFactory: () => ({}),
        BotClass: FakeBot,
        notifier: nullNotifier,
        engineManager: {
            getEngine: () => ({ready: true}),
            count: () => 0,
            hasCapacity: () => true,
            maxEngines: 4,
        },
        ...overrides,
    });
    server = app.listen(0);
    base = `http://localhost:${server.address().port}`;
}

// Most routes require a running bot; this hits /start so the controller holds an
// instance, then returns the fake so the test can inspect recorded calls.
async function startBot(): Promise<FakeBot> {
    const res = await fetch(`${base}/api/lichess/start`, {method: "POST"});
    expect(res.status).toBe(200);
    return FakeBot.last!;
}

const post = (path: string, body?: any) =>
    fetch(`${base}${path}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
const get = (path: string) => fetch(`${base}${path}`);

beforeEach(() => {
    botState = {};
    FakeBot.last = null;
    buildApp();
});

afterEach(() => {
    server?.close();
});

describe("POST /api/lichess/start", () => {
    it("starts the bot and returns 200", async () => {
        const res = await post("/api/lichess/start");
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.status).toBe("success");
        expect(FakeBot.last!.calls.start).toHaveLength(1);
    });

    it("returns 400 when the bot is already running", async () => {
        await post("/api/lichess/start");
        const res = await post("/api/lichess/start");
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/already running/i);
    });

    it("returns 400 when no token is configured", async () => {
        server.close();
        buildApp({getToken: () => undefined});
        const res = await post("/api/lichess/start");
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/token/i);
    });

    it("returns 500 when the bot fails to start", async () => {
        botState.startThrows = true;
        const res = await post("/api/lichess/start");
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe("start failed");
    });
});

describe("POST /api/lichess/stop", () => {
    it("stops a running bot", async () => {
        const bot = await startBot();
        const res = await post("/api/lichess/stop");
        expect(res.status).toBe(200);
        expect((await res.json()).status).toBe("success");
        expect(bot.calls.stop).toHaveLength(1);
    });

    it("is a no-op (ignored) when the bot was not running", async () => {
        const res = await post("/api/lichess/stop");
        expect(res.status).toBe(200);
        expect((await res.json()).status).toBe("ignored");
    });
});

describe("GET /api/lichess/status", () => {
    it("reports not-running before start", async () => {
        const body = await (await get("/api/lichess/status")).json();
        expect(body.running).toBe(false);
        expect(body.profile).toBeNull();
    });

    it("reports running state, profile and active games once started", async () => {
        await startBot();
        const body = await (await get("/api/lichess/status")).json();
        expect(body.running).toBe(true);
        expect(body.profile).toBe("fakebot");
        expect(body.activeGames).toEqual(["game_a"]);
        expect(body.declinedCount).toBe(1);
    });
});

describe("POST /api/lichess/challenge/open", () => {
    it("returns 400 when the bot is not running", async () => {
        const res = await post("/api/lichess/challenge/open", {limit: 60});
        expect(res.status).toBe(400);
    });

    it("passes the requested time control through and returns the challenge", async () => {
        const bot = await startBot();
        const res = await post("/api/lichess/challenge/open", {limit: 600, increment: 5, rated: false});
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({id: "challenge_1"});
        expect(bot.calls.createOpenChallenge[0]).toEqual([600, 5, false]);
    });

    it("applies defaults (180+0, rated) when the body is empty", async () => {
        const bot = await startBot();
        await post("/api/lichess/challenge/open");
        expect(bot.calls.createOpenChallenge[0]).toEqual([180, 0, true]);
    });

    it("returns 500 when the challenge call throws", async () => {
        await startBot();
        botState.challengeThrows = true;
        const res = await post("/api/lichess/challenge/open", {limit: 60});
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe("challenge failed");
    });
});

describe("POST /api/lichess/challenge/ai", () => {
    it("returns 400 when the bot is not running", async () => {
        expect((await post("/api/lichess/challenge/ai", {level: 3})).status).toBe(400);
    });

    it("forwards level + time control to createAiChallenge", async () => {
        const bot = await startBot();
        const res = await post("/api/lichess/challenge/ai", {level: 5, limit: 600, increment: 2});
        expect(res.status).toBe(200);
        expect(bot.calls.createAiChallenge[0]).toEqual([5, 600, 2]);
    });
});

describe("POST /api/lichess/challenge/weakest", () => {
    it("returns 400 when the bot is not running", async () => {
        expect((await post("/api/lichess/challenge/weakest")).status).toBe(400);
    });

    it("hunts the weakest bot and returns the result", async () => {
        const bot = await startBot();
        const res = await post("/api/lichess/challenge/weakest", {limit: 120, increment: 1, rated: false});
        expect(res.status).toBe(200);
        expect((await res.json())).toMatchObject({status: "success", gameId: "g1"});
        expect(bot.calls.huntWeakestBot[0]).toEqual([120, 1, false]);
    });

    it("returns 500 when the hunt throws", async () => {
        await startBot();
        botState.challengeThrows = true;
        expect((await post("/api/lichess/challenge/weakest")).status).toBe(500);
    });
});

describe("POST /api/lichess/autoplay/start", () => {
    it("returns 400 when the bot is not running", async () => {
        expect((await post("/api/lichess/autoplay/start")).status).toBe(400);
    });

    it("starts autoplay with the requested config and echoes status", async () => {
        const bot = await startBot();
        const res = await post("/api/lichess/autoplay/start", {limit: 300, increment: 3, target: 2, mode: "weakest"});
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.autoplay.enabled).toBe(true);
        expect(bot.calls.startAutoplay[0][0]).toMatchObject({limit: 300, increment: 3, target: 2, mode: "weakest"});
    });
});

describe("POST /api/lichess/autoplay/stop", () => {
    it("returns 400 when the bot is not running", async () => {
        expect((await post("/api/lichess/autoplay/stop")).status).toBe(400);
    });

    it("stops autoplay on a running bot", async () => {
        const bot = await startBot();
        await post("/api/lichess/autoplay/start", {});
        const res = await post("/api/lichess/autoplay/stop");
        expect(res.status).toBe(200);
        expect(bot.calls.stopAutoplay).toHaveLength(1);
    });
});

describe("GET /api/lichess/autoplay/status", () => {
    it("reports botRunning=false before start", async () => {
        const body = await (await get("/api/lichess/autoplay/status")).json();
        expect(body).toEqual({enabled: false, botRunning: false});
    });

    it("reports enabled autoplay once started", async () => {
        await startBot();
        await post("/api/lichess/autoplay/start", {limit: 180});
        const body = await (await get("/api/lichess/autoplay/status")).json();
        expect(body.enabled).toBe(true);
    });
});
