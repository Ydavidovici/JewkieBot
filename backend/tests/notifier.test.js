import {expect, test, mock, describe, beforeEach, afterEach} from "bun:test";
import {Notifier, wrapConsoleForNotifier, CONSOLE_WRAP_SKIP_PREFIXES} from "../src/notifier.js";

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
        // Suppress actual terminal output during the test.
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

        // Each of these would otherwise loop the notifier.
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

    test("a transport that logs via console.error does not cause a feedback loop", async () => {
        // Transport that always logs to console.error with a known internal prefix.
        const transportCalls = [];
        const loggingTransport = {
            send: (event) => {
                transportCalls.push(event);
                // This is the recursive risk: if the wrapper didn't skip
                // "[ApiTransport]" lines, this would re-enter notifier.error
                // and spiral.
                console.error("[ApiTransport] simulated transport error");
            },
        };
        const notifier = new Notifier({transports: [loggingTransport]});
        console.log   = mock(() => {});
        console.error = mock(() => {});
        restore = wrapConsoleForNotifier(notifier);

        console.log("one user log");

        // Yield to drain any microtasks the wrapper might schedule.
        await new Promise(r => setTimeout(r, 10));

        // The transport gets the original user log AND any unprefixed wrapper
        // forwards — but the "[ApiTransport]" log must NOT have looped back in.
        const internalLoopback = transportCalls.find(e => typeof e.subject === "string" && e.subject.includes("[ApiTransport]"));
        expect(internalLoopback).toBeUndefined();
    });
});
