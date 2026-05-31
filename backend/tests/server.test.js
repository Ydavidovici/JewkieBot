import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

let mockBotInstances = [];
let nextStartBehavior = null;

class MockLichessBot {
    constructor(token, factory, opts) {
        this.token = token;
        this.factory = factory;
        this.maxConcurrentGames = opts?.maxConcurrentGames ?? 4;
        this.activeGames = new Set();
        this.botProfile = null;
        this.recentlyDeclined = new Map();
        this._rateLimitRemainingSec = mock(() => 0);
        this._ensureProfile = mock(async () => true);
        mockBotInstances.push(this);

        this.stop = mock(() => {});
        this.createOpenChallenge = mock(async (limit, increment, rated) => ({ id: "open_ch", limit, increment, rated }));
        this.createAiChallenge = mock(async (level, limit, increment) => ({ id: "ai_ch", level, limit, increment }));
        this.huntWeakestBot = mock(async () => ({ status: "success", gameId: "weakest_game", message: "Playing vs Weak" }));
    }

    async start() {
        if (nextStartBehavior) {
            const b = nextStartBehavior;
            nextStartBehavior = null;
            return b();
        }
        this.botProfile = "mockBot";
    }
}

class MockUciEngine {}

class MockEngineCapReached extends Error {
    constructor(cap, current) {
        super(`Engine spawn cap reached (${current}/${cap})`);
        this.name = "EngineCapReached";
        this.cap = cap;
        this.current = current;
    }
}

class MockEngineManager {
    constructor() {
        this.engines = new Map();
        this.shutdownEngineCalls = [];
        this.registerEngineCalls = [];
        this.maxEngines = Infinity;
    }
    count() {
        return this.engines.size;
    }
    hasCapacity() {
        return this.engines.size < this.maxEngines;
    }
    getEngine(id) {
        if (!this.engines.has(id)) throw new Error(`Engine ${id} not found.`);
        return this.engines.get(id);
    }
    async registerEngine(id, path) {
        this.registerEngineCalls.push({ id, path });
        const e = {
            ready: true,
            position: mock(async () => {}),
            go: mock(async () => "e2e4"),
            uciNewGame: mock(async () => {}),
            bench: mock(async () => ({ nps: 1234, nodes: 100 })),
            stop: mock(async () => {}),
        };
        this.engines.set(id, e);
        return e;
    }
    async shutdownEngine(id) {
        this.shutdownEngineCalls.push(id);
        this.engines.delete(id);
    }
}

mock.module("../src/engineManager.js", () => ({
    EngineManager: MockEngineManager,
    UciEngine: MockUciEngine,
    EngineCapReached: MockEngineCapReached,
}));



const { createApp } = await import("../src/server.js");

let server;
let baseUrl;
let manager;
let factoryCalls;
let tokenValue;

async function POST(path, body) {
    return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
}
function GET(path) {
    return fetch(`${baseUrl}${path}`);
}

beforeEach(async () => {
    mockBotInstances = [];
    nextStartBehavior = null;
    factoryCalls = 0;
    tokenValue = "test_token";

    manager = new MockEngineManager();
    await manager.registerEngine("Main", "/fake/path/jewkiebot");

    const { app } = createApp({
        manager,
        lichessEngineFactory: () => { factoryCalls++; return new MockUciEngine(); },
        mainEnginePath: "/fake/path/jewkiebot",
        maxConcurrentGames: 4,
        getToken: () => tokenValue,
        BotClass: MockLichessBot,
    });

    await new Promise((resolve) => {
        server = app.listen(0, () => resolve());
    });
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
});

afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
});

describe("GET /api/health", () => {
    it("returns 200 with engine status", async () => {
        const res = await GET("/api/health");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ status: "ok", engine: "ready" });
        // Extra fields exposed for monitoring; assert their shape, not exact values.
        expect(typeof body.engineCount).toBe("number");
        expect(typeof body.botRunning).toBe("boolean");
        expect(typeof body.activeGames).toBe("number");
        expect(typeof body.uptimeSec).toBe("number");
    });

    it("reports engine as 'starting' when not ready", async () => {
        manager.getEngine("Main").ready = false;
        const res = await GET("/api/health");
        const body = await res.json();
        expect(body.engine).toBe("starting");
    });
});

describe("POST /api/engine/analysis", () => {
    it("returns 400 when fen is missing", async () => {
        const res = await POST("/api/engine/analysis", {});
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/FEN required/i);
    });

    it("returns bestMove and depth on success", async () => {
        const engine = manager.getEngine("Main");
        engine.go = mock(async () => "d2d4");
        const res = await POST("/api/engine/analysis", { fen: "startpos", depth: 5 });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ bestMove: "d2d4", depth: 5 });
        expect(engine.position).toHaveBeenCalledWith("startpos");
        expect(engine.go).toHaveBeenCalledWith({ depth: 5 });
    });

    it("defaults depth to 10 when not provided", async () => {
        const engine = manager.getEngine("Main");
        await POST("/api/engine/analysis", { fen: "startpos" });
        expect(engine.go).toHaveBeenCalledWith({ depth: 10 });
    });

    it("returns 500 when engine.go throws", async () => {
        const engine = manager.getEngine("Main");
        engine.go = mock(async () => { throw new Error("engine crash"); });
        const res = await POST("/api/engine/analysis", { fen: "startpos" });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toContain("engine crash");
    });
});

describe("POST /api/engine/go", () => {
    it("defaults to startpos and depth=7", async () => {
        const engine = manager.getEngine("Main");
        const res = await POST("/api/engine/go", {});
        expect(res.status).toBe(200);
        expect(engine.position).toHaveBeenCalledWith("startpos", []);
        expect(engine.go).toHaveBeenCalledWith({ depth: 7 });
    });

    it("passes through provided fen, moves, options", async () => {
        const engine = manager.getEngine("Main");
        await POST("/api/engine/go", {
            fen: "8/8/8/8/8/8/8/8 w - - 0 1",
            moves: ["e2e4", "e7e5"],
            options: { moveTime: 2000 },
        });
        expect(engine.position).toHaveBeenCalledWith("8/8/8/8/8/8/8/8 w - - 0 1", ["e2e4", "e7e5"]);
        expect(engine.go).toHaveBeenCalledWith({ moveTime: 2000 });
    });

    it("returns 500 on engine error", async () => {
        const engine = manager.getEngine("Main");
        engine.position = mock(async () => { throw new Error("bad fen"); });
        const res = await POST("/api/engine/go", { fen: "garbage" });
        expect(res.status).toBe(500);
    });
});

describe("POST /api/engine/reset", () => {
    it("calls uciNewGame on the main engine", async () => {
        const engine = manager.getEngine("Main");
        const res = await POST("/api/engine/reset");
        expect(res.status).toBe(200);
        expect(engine.uciNewGame).toHaveBeenCalledTimes(1);
        const body = await res.json();
        expect(body.status).toBe("reset_complete");
    });
});

describe("POST /api/engine/bench", () => {
    it("passes through bench params and returns results", async () => {
        const engine = manager.getEngine("Main");
        const res = await POST("/api/engine/bench", { mode: "time", depth: 12, timeLimit: 5000, evalTime: 1000 });
        expect(res.status).toBe(200);
        expect(engine.bench).toHaveBeenCalledWith({ mode: "time", depth: 12, timeLimit: 5000, evalTime: 1000 });
        const body = await res.json();
        expect(body.data).toEqual({ nps: 1234, nodes: 100 });
    });

    it("applies defaults when body is empty", async () => {
        const engine = manager.getEngine("Main");
        await POST("/api/engine/bench", {});
        expect(engine.bench).toHaveBeenCalledWith({ mode: "depth", depth: 9, timeLimit: 30000, evalTime: 2000 });
    });

    it("returns 500 when bench throws", async () => {
        const engine = manager.getEngine("Main");
        engine.bench = mock(async () => { throw new Error("bench died"); });
        const res = await POST("/api/engine/bench", {});
        expect(res.status).toBe(500);
    });
});

describe("POST /api/engine/cancel", () => {
    it("shuts down and re-registers the Main engine", async () => {
        const res = await POST("/api/engine/cancel");
        expect(res.status).toBe(200);
        expect(manager.shutdownEngineCalls).toContain("Main");
        expect(manager.registerEngineCalls.some(c => c.id === "Main" && c.path === "/fake/path/jewkiebot")).toBe(true);
    });

    it("returns 500 when re-registration fails", async () => {
        const original = manager.registerEngine.bind(manager);
        let calls = 0;
        manager.registerEngine = async (id, path) => {
            calls++;
            if (calls > 1) throw new Error("respawn failed");
            return original(id, path);
        };
        await POST("/api/engine/cancel").catch(() => {});
        // Now the second cancel should hit the failing path
        const res = await POST("/api/engine/cancel");
        expect(res.status).toBe(500);
    });
});

describe("POST /api/lichess/start", () => {
    it("returns 400 when token is missing", async () => {
        tokenValue = null;
        const res = await POST("/api/lichess/start");
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/token/i);
    });

    it("starts the bot, awaits start(), returns 200", async () => {
        const res = await POST("/api/lichess/start");
        expect(res.status).toBe(200);
        expect(mockBotInstances).toHaveLength(1);
        expect(mockBotInstances[0].botProfile).toBe("mockBot");
        const body = await res.json();
        expect(body.message).toContain("max 4 concurrent");
    });

    it("returns 400 if the bot is already running", async () => {
        await POST("/api/lichess/start");
        const res = await POST("/api/lichess/start");
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/already running/i);
    });

    it("returns 500 (and does not register the instance) when bot.start() throws", async () => {
        nextStartBehavior = async () => { throw new Error("network unavailable"); };
        const res = await POST("/api/lichess/start");
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toContain("network unavailable");

        // status should still report not running
        const statusRes = await GET("/api/lichess/status");
        const status = await statusRes.json();
        expect(status.running).toBe(false);

        // a second attempt should not be blocked by 'already running'
        const retry = await POST("/api/lichess/start");
        expect(retry.status).toBe(200);
    });

    it("constructs LichessBot with the configured maxConcurrentGames", async () => {
        await POST("/api/lichess/start");
        expect(mockBotInstances[0].maxConcurrentGames).toBe(4);
    });
});

describe("POST /api/lichess/stop", () => {
    it("returns ignored when bot is not running", async () => {
        const res = await POST("/api/lichess/stop");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("ignored");
    });

    it("stops the bot and returns success", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        const res = await POST("/api/lichess/stop");
        expect(res.status).toBe(200);
        expect(bot.stop).toHaveBeenCalled();
        const body = await res.json();
        expect(body.status).toBe("success");
    });

    it("clears the instance so start() works again", async () => {
        await POST("/api/lichess/start");
        await POST("/api/lichess/stop");
        const res = await POST("/api/lichess/start");
        expect(res.status).toBe(200);
        expect(mockBotInstances).toHaveLength(2);
    });
});

describe("GET /api/lichess/status", () => {
    it("returns running=false and maxConcurrentGames when no bot", async () => {
        const res = await GET("/api/lichess/status");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
            running: false,
            profile: null,
            activeGames: [],
            maxConcurrentGames: 4,
            rateLimitedFor: 0,
            declinedCount: 0,
        });
    });

    it("returns running=true, profile, and activeGames when running", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        bot.activeGames.add("game_xyz");
        const res = await GET("/api/lichess/status");
        const body = await res.json();
        expect(body.running).toBe(true);
        expect(body.profile).toBe("mockBot");
        expect(body.activeGames).toEqual(["game_xyz"]);
        expect(body.maxConcurrentGames).toBe(4);
        expect(body.rateLimitedFor).toBe(0);
        expect(body.declinedCount).toBe(0);
    });
});

describe("POST /api/lichess/challenge/open", () => {
    it("returns 400 when bot is not running", async () => {
        const res = await POST("/api/lichess/challenge/open", {});
        expect(res.status).toBe(400);
    });

    it("passes through limit, increment, rated; returns result", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        const res = await POST("/api/lichess/challenge/open", { limit: 600, increment: 5, rated: false });
        expect(res.status).toBe(200);
        expect(bot.createOpenChallenge).toHaveBeenCalledWith(600, 5, false);
    });

    it("uses defaults (180+0 rated) when body is empty", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        await POST("/api/lichess/challenge/open", {});
        expect(bot.createOpenChallenge).toHaveBeenCalledWith(180, 0, true);
    });

    it("returns 500 when createOpenChallenge throws", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        bot.createOpenChallenge = mock(async () => { throw new Error("api down"); });
        const res = await POST("/api/lichess/challenge/open", {});
        expect(res.status).toBe(500);
    });
});

describe("POST /api/lichess/challenge/ai", () => {
    it("returns 400 when bot is not running", async () => {
        const res = await POST("/api/lichess/challenge/ai", { level: 5 });
        expect(res.status).toBe(400);
    });

    it("passes level/limit/increment; defaults are level=1, 180+0", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        await POST("/api/lichess/challenge/ai", {});
        expect(bot.createAiChallenge).toHaveBeenCalledWith(1, 180, 0);
    });

    it("passes through provided params", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        await POST("/api/lichess/challenge/ai", { level: 3, limit: 60, increment: 1 });
        expect(bot.createAiChallenge).toHaveBeenCalledWith(3, 60, 1);
    });
});

describe("POST /api/lichess/challenge/weakest", () => {
    it("returns 400 when bot is not running", async () => {
        const res = await POST("/api/lichess/challenge/weakest", {});
        expect(res.status).toBe(400);
    });

    it("returns the hunt result on success", async () => {
        await POST("/api/lichess/start");
        const res = await POST("/api/lichess/challenge/weakest", { limit: 60, increment: 0, rated: true });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "success", gameId: "weakest_game", message: "Playing vs Weak" });
    });

    it("returns 500 when the hunt throws", async () => {
        await POST("/api/lichess/start");
        const bot = mockBotInstances[0];
        bot.huntWeakestBot = mock(async () => { throw new Error("no candidates"); });
        const res = await POST("/api/lichess/challenge/weakest", {});
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toContain("no candidates");
    });
});
