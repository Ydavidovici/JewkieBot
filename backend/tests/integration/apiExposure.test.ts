import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// What the backend does with requests the gateway should have stopped.
//
// jewkiebot has no auth of its own: nginx's auth_request on `location /api/`
// is the only gate (see dss/tests/gateway.test.ts). These tests assert the
// backend's side of that contract, so a failure here is a gap:
//   - only the exact lowercase /api/ paths nginx gates may reach a handler
//   - every request to an unknown API path is answered with a JSON 404 and logged

let startCalls = 0;

class MockLichessBot { [key: string]: any;
    constructor() {
        this.activeGames = new Set();
        this.botProfile = null;
        this.recentlyDeclined = new Map();
        this._rateLimitRemainingSec = mock(() => 0);
        this._maxBotGamesRemainingSec = mock(() => 0);
        this.getTournaments = mock(() => []);
        this.stop = mock(() => {});
    }
    async start() {
        startCalls++;
        this.botProfile = "mockBot";
    }
}

class MockEngineManager { [key: string]: any;
    constructor() {
        this.engines = new Map();
        this.maxEngines = Infinity;
    }
    count() { return this.engines.size; }
    hasCapacity() { return true; }
    getEngine(id) {
        if (!this.engines.has(id)) throw new Error(`Engine ${id} not found.`);
        return this.engines.get(id);
    }
    async registerEngine(id) {
        const e = { ready: true, position: mock(async () => {}), go: mock(async () => ({ bestMove: "e2e4" })) };
        this.engines.set(id, e);
        return e;
    }
}

const { createApp } = await import("../../src/server.ts");

let server;
let baseUrl;
let errors: string[];
let accessLines: string[];

const originalConsoleError = console.error;

beforeEach(async () => {
    console.error = mock(() => {});
    startCalls = 0;
    errors = [];
    accessLines = [];
    const manager = new MockEngineManager();
    await manager.registerEngine("Main");

    const { app } = createApp({
        engineManager: manager,
        lichessEngineFactory: () => ({}),
        mainEnginePath: "/fake/path/jewkiebot",
        getToken: () => "test_token",
        BotClass: MockLichessBot,
        notifier: { error: (msg: string) => errors.push(msg), info: () => {}, warn: () => {} },
        accessLog: (line: string) => accessLines.push(line),
    });

    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://localhost:${server.address().port}`;
});

afterEach(async () => {
    console.error = originalConsoleError;
    await new Promise<void>((resolve) => server?.close(resolve));
});

describe("unknown API paths get a JSON 404 and are logged", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        it(`${method} /api/mcp`, async () => {
            const res = await fetch(`${baseUrl}/api/mcp`, { method });
            expect(res.status).toBe(404);
            expect(res.headers.get("content-type")).toContain("application/json");
            expect(errors).toContain(`[API] ${method} /api/mcp → 404`);
        });
    }
});

describe("only lowercase /api/ reaches a handler (nginx gates no other casing)", () => {
    for (const path of ["/API/lichess/status", "/Api/lichess/status", "/aPi/lichess/status"]) {
        it(`GET ${path} is not routed to the handler`, async () => {
            const res = await fetch(`${baseUrl}${path}`);
            expect(res.status).toBe(404);
        });
    }

    it("POST /API/lichess/start does not start the bot", async () => {
        const res = await fetch(`${baseUrl}/API/lichess/start`, { method: "POST" });
        expect(res.status).toBe(404);
        expect(startCalls).toBe(0);
    });

    it("GET /API/mcp is answered and logged as an API 404, not served the SPA", async () => {
        const res = await fetch(`${baseUrl}/API/mcp`);
        expect(res.status).toBe(404);
        expect(errors).toContain("[API] GET /API/mcp → 404");
    });
});

describe("every request is access-logged", () => {
    // The line is written when the response finishes, which can land just
    // after fetch resolves.
    const settle = () => new Promise(r => setTimeout(r, 20));

    it("logs the client IP nginx forwarded", async () => {
        await fetch(`${baseUrl}/api/mcp`, { method: "POST", headers: { "X-Real-IP": "203.0.113.7", "User-Agent": "probe/1.0" } });
        await settle();
        expect(accessLines).toEqual([expect.stringMatching(/^\[HTTP\] 203\.0\.113\.7 POST \/api\/mcp → 404 \d+ms "probe\/1\.0"$/)]);
    });

    it("marks requests that skipped nginx as direct", async () => {
        await fetch(`${baseUrl}/.env`);
        await settle();
        expect(accessLines[0]).toStartWith("[HTTP] direct:");
    });
});

describe("by design: the backend trusts whatever reaches it", () => {
    // Not a gap on its own — auth lives in the gateway. This is why any
    // gateway bypass hands over the whole control API.
    it("serves the control API without a cookie or token", async () => {
        const res = await fetch(`${baseUrl}/api/lichess/status`);
        expect(res.status).toBe(200);
    });

    it("lets an anonymous caller start the Lichess bot", async () => {
        const res = await fetch(`${baseUrl}/api/lichess/start`, { method: "POST" });
        expect(res.status).toBe(200);
        expect(startCalls).toBe(1);
    });
});
