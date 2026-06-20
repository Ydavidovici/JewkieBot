import {expect, test, mock, describe, beforeEach, afterEach} from "bun:test";
import {Notifier, wrapConsoleForNotifier, CONSOLE_WRAP_SKIP_PREFIXES, WebhookTransport} from "../src/notifier.js";
import {ApiTransport} from "../src/apiTransport.js";

describe("WebhookTransport", () => {
    let originalEnv;

    beforeEach(() => {
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
        for (const [k, v] of Object.entries(originalEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    test("is disabled when url or token is missing", async () => {
        const t = new WebhookTransport();
        expect(t.enabled).toBe(false);
        // Ensure no error when calling send
        await t.send({level: "info", subject: "anything"});
    });

    test("posts info logs to the 'notifications' channel with status=success", async () => {
        const t = new WebhookTransport({url: "http://test/notify", token: "tk", project: "proj"});
        t.api.post = mock(async () => ({}));

        await t.send({
            level: "info",
            subject: "[Server] Started",
            details: {port: 8000},
        });

        expect(t.api.post).toHaveBeenCalled();
        const payload = t.api.post.mock.calls[0][1];
        
        expect(payload.channel).toBe("notifications");
        expect(payload.status).toBe("success");
        expect(payload.project).toBe("proj");
        expect(payload.message).toContain("[ INFO ] [Server] Started");
        expect(payload.message).toContain(`"port": 8000`);
    });

    test("error/fatal levels set status=error and use the 'notifications' channel", async () => {
        const t = new WebhookTransport({url: "http://test/notify", token: "tk"});
        t.api.post = mock(async () => ({}));

        await t.send({level: "error", subject: "[EngineManager] Engine crashed"});

        const payload = t.api.post.mock.calls[0][1];
        expect(payload.channel).toBe("notifications");
        expect(payload.status).toBe("error");
    });

    test("reads url/token/project from env vars when no opts passed", () => {
        process.env.API_NOTIFY_URL = "http://from-env/notify";
        process.env.API_NOTIFY_TOKEN = "env_tok";
        process.env.API_NOTIFY_PROJECT = "from-env-proj";

        const t = new WebhookTransport();
        expect(t.enabled).toBe(true);
        expect(t.api.baseUrl).toBe("http://from-env/notify");
        expect(t.api.token).toBe("env_tok");
        expect(t.project).toBe("from-env-proj");
    });
});

describe("wrapConsoleForNotifier", () => {
    let origConsole;
    let restore;

    beforeEach(() => {
        origConsole = {
            log:   console.log,
            info:  console.info,
            warn:  console.warn,
            error: console.error,
        };
        restore = null;
    });

    afterEach(() => {
        if (restore) restore();
        console.log   = origConsole.log;
        console.info  = origConsole.info;
        console.warn  = origConsole.warn;
        console.error = origConsole.error;
    });

    test("forwards console.log → notifier.info", () => {
        const events = [];
        const notifier = new Notifier({transports: [{send: (e) => events.push(e)}]});
        console.log = mock(() => {});
        restore = wrapConsoleForNotifier(notifier);

        console.log("hello world");

        expect(events.length).toBe(1);
        expect(events[0]).toMatchObject({level: "info", subject: "hello world"});
    });

    test("forwards console.warn → notifier.warn and .error → notifier.error", () => {
        const events = [];
        const notifier = new Notifier({transports: [{send: (e) => events.push(e)}]});
        console.warn  = mock(() => {});
        console.error = mock(() => {});
        restore = wrapConsoleForNotifier(notifier);

        console.warn("careful");
        console.error("bad");

        expect(events.map(e => e.level)).toEqual(["warn", "error"]);
        expect(events[0].subject).toBe("careful");
        expect(events[1].subject).toBe("bad");
    });

    test("preserves the original terminal call", () => {
        const notifier = new Notifier({transports: []});
        const fakeLog = mock(() => {});
        console.log = fakeLog;
        restore = wrapConsoleForNotifier(notifier);

        console.log("printed", 42);

        expect(fakeLog).toHaveBeenCalledTimes(1);
        expect(fakeLog).toHaveBeenCalledWith("printed", 42);
    });

    test("skips re-forwarding lines whose first arg starts with an internal prefix", () => {
        const events = [];
        const notifier = new Notifier({transports: [{send: (e) => events.push(e)}]});
        console.error = mock(() => {});
        restore = wrapConsoleForNotifier(notifier);

        for (const prefix of CONSOLE_WRAP_SKIP_PREFIXES) {
            console.error(`${prefix} something happened`);
        }

        expect(events.length).toBe(0);
    });

    test("formats multiple args, including objects and Errors", () => {
        const events = [];
        const notifier = new Notifier({transports: [{send: (e) => events.push(e)}]});
        console.log = mock(() => {});
        restore = wrapConsoleForNotifier(notifier);

        console.log("got payload", {a: 1, b: [2, 3]});
        const err = new Error("boom");
        console.log("after error:", err);

        expect(events.length).toBe(2);
        expect(events[0].subject).toBe(`got payload {"a":1,"b":[2,3]}`);
        expect(events[1].subject).toContain("after error:");
        expect(events[1].subject).toContain("boom");
    });

    test("restore() puts the originals back", () => {
        const notifier = new Notifier({transports: []});
        const sentinel = mock(() => {});
        console.log = sentinel;

        const r = wrapConsoleForNotifier(notifier);
        expect(console.log).not.toBe(sentinel);
        r();
        expect(console.log).toBe(sentinel);
    });
});
