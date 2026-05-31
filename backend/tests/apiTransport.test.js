import {expect, test, mock, describe, beforeEach, afterEach} from "bun:test";
import {ApiTransport} from "../src/apiTransport.js";

describe("ApiTransport", () => {
    let originalFetch;
    let originalEnv;

    beforeEach(() => {
        originalFetch = global.fetch;
        originalEnv = {
            API_NOTIFY_URL: process.env.API_NOTIFY_URL,
            API_NOTIFY_TOKEN: process.env.API_NOTIFY_TOKEN,
            API_NOTIFY_PROJECT: process.env.API_NOTIFY_PROJECT,
        };
        delete process.env.API_NOTIFY_URL;
        delete process.env.API_NOTIFY_TOKEN;
        delete process.env.API_NOTIFY_PROJECT;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        for (const [k, v] of Object.entries(originalEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    test("is disabled (and silent) when url or token is missing", async () => {
        const fetchMock = mock(async () => ({ok: true}));
        global.fetch = fetchMock;

        const t = new ApiTransport();
        expect(t.enabled).toBe(false);
        await t.send({level: "info", subject: "anything"});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("posts info logs to the 'logs' channel with no status field", async () => {
        const fetchMock = mock(async () => ({ok: true}));
        global.fetch = fetchMock;

        const t = new ApiTransport({url: "http://test/notify", token: "tk", project: "proj"});
        await t.send({
            level: "info",
            subject: "[Server] Started",
            details: {port: 8000},
        });

        expect(fetchMock).toHaveBeenCalled();
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("http://test/notify");
        expect(opts.headers["Authorization"]).toBe("Bearer tk");
        expect(opts.headers["Content-Type"]).toBe("application/json");

        const body = JSON.parse(opts.body);
        expect(body.channel).toBe("logs");
        expect(body.status).toBeUndefined();
        expect(body.project).toBe("proj");
        expect(body.message).toContain("[ INFO ] [Server] Started");
        expect(body.message).toContain(`"port": 8000`);
    });

    test("routes autoplay restart events to 'notifications' with status=success", async () => {
        const fetchMock = mock(async () => ({ok: true}));
        global.fetch = fetchMock;

        const t = new ApiTransport({url: "http://test/notify", token: "tk"});
        await t.send({level: "info", subject: "[Autoplay] Autoplay restarted after rate limit"});

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.channel).toBe("notifications");
        expect(body.status).toBe("success");
    });

    test("routes rate-limit events to 'notifications'", async () => {
        const fetchMock = mock(async () => ({ok: true}));
        global.fetch = fetchMock;

        const t = new ApiTransport({url: "http://test/notify", token: "tk"});
        await t.send({level: "warn", subject: "[Autoplay] Rate-limited; skipping tick"});

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.channel).toBe("notifications");
        expect(body.status).toBe("success");
    });

    test("error/fatal levels set status=error and stay on the 'logs' channel", async () => {
        const fetchMock = mock(async () => ({ok: true}));
        global.fetch = fetchMock;

        const t = new ApiTransport({url: "http://test/notify", token: "tk"});
        await t.send({level: "error", subject: "[EngineManager] Engine crashed"});

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.channel).toBe("logs");
        expect(body.status).toBe("error");
    });

    test("omits the details block when details are empty/missing", async () => {
        const fetchMock = mock(async () => ({ok: true}));
        global.fetch = fetchMock;

        const t = new ApiTransport({url: "http://test/notify", token: "tk"});
        await t.send({level: "warn", subject: "Something happened"});

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.message).toBe("```\n[ WARN ] Something happened\n```");
    });

    test("reads url/token/project from env vars when no opts passed", () => {
        process.env.API_NOTIFY_URL = "http://from-env/notify";
        process.env.API_NOTIFY_TOKEN = "env_tok";
        process.env.API_NOTIFY_PROJECT = "from-env-proj";

        const t = new ApiTransport();
        expect(t.enabled).toBe(true);
        expect(t.url).toBe("http://from-env/notify");
        expect(t.token).toBe("env_tok");
        expect(t.project).toBe("from-env-proj");
    });

    test("swallows network errors (does not throw)", async () => {
        global.fetch = mock(async () => { throw new Error("network down"); });

        const t = new ApiTransport({url: "http://test/notify", token: "tk"});
        // Should not throw.
        await t.send({level: "info", subject: "x"});
    });

    test("swallows non-ok HTTP responses", async () => {
        global.fetch = mock(async () => ({ok: false, status: 500, text: async () => "err"}));

        const t = new ApiTransport({url: "http://test/notify", token: "tk"});
        await t.send({level: "info", subject: "x"});
    });
});
