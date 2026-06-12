import {expect, test, mock, describe, beforeEach, afterEach} from "bun:test";
import {HealthPinger, DiscordTransport} from "../src/discordBot.js";

describe("HealthPinger", () => {
    let sendFnMock;

    beforeEach(() => {
        sendFnMock = mock(async () => {});
    });

    test("announces UP when health check succeeds", async () => {
        const pinger = new HealthPinger({ url: "http://test/health", sendFn: sendFnMock, channelId: "123", label: "my-service" });
        pinger.api.get = mock(async () => "ok");

        await pinger._tick();

        expect(pinger.api.get).toHaveBeenCalled();
        expect(sendFnMock).toHaveBeenCalledTimes(1);
        expect(sendFnMock.mock.calls[0][1]).toContain(":white_check_mark: my-service is UP");
        expect(pinger.lastStatus).toBe(true);
    });

    test("announces DOWN when health check fails", async () => {
        const pinger = new HealthPinger({ url: "http://test/health", sendFn: sendFnMock, channelId: "123", label: "my-service" });
        pinger.api.get = mock(async () => { throw new Error("HTTP 500"); });

        await pinger._tick();

        expect(pinger.api.get).toHaveBeenCalled();
        expect(sendFnMock).toHaveBeenCalledTimes(1);
        expect(sendFnMock.mock.calls[0][1]).toContain(":x: my-service is DOWN");
        expect(pinger.lastStatus).toBe(false);
    });

    test("only announces on state transitions", async () => {
        const pinger = new HealthPinger({ url: "http://test/health", sendFn: sendFnMock, channelId: "123", label: "my-service" });
        
        // Starts UP
        pinger.api.get = mock(async () => "ok");
        await pinger._tick();
        expect(sendFnMock).toHaveBeenCalledTimes(1);
        expect(pinger.lastStatus).toBe(true);

        // Still UP, should not announce
        await pinger._tick();
        expect(sendFnMock).toHaveBeenCalledTimes(1);

        // Goes DOWN
        pinger.api.get = mock(async () => { throw new Error("timeout"); });
        await pinger._tick();
        expect(sendFnMock).toHaveBeenCalledTimes(2);
        expect(sendFnMock.mock.calls[1][1]).toContain(":x: my-service went DOWN");
        expect(pinger.lastStatus).toBe(false);

        // Still DOWN, should not announce
        await pinger._tick();
        expect(sendFnMock).toHaveBeenCalledTimes(2);

        // Recovers
        pinger.api.get = mock(async () => "ok");
        await pinger._tick();
        expect(sendFnMock).toHaveBeenCalledTimes(3);
        expect(sendFnMock.mock.calls[2][1]).toContain("my-service recovered (was down 2 previous checks)");
        expect(pinger.lastStatus).toBe(true);
    });
});

describe("DiscordTransport", () => {
    let sendFnMock;

    beforeEach(() => {
        sendFnMock = mock(async () => {});
    });

    test("buffers messages and flushes them together", async () => {
        const t = new DiscordTransport({ channelId: "123", sendFn: sendFnMock, flushIntervalMs: 50 });
        
        t.send({ level: "info", subject: "event 1" });
        t.send({ level: "warn", subject: "event 2" });
        
        expect(sendFnMock).not.toHaveBeenCalled();

        await new Promise(r => setTimeout(r, 60)); // wait for flush

        expect(sendFnMock).toHaveBeenCalledTimes(1);
        const payload = sendFnMock.mock.calls[0][1];
        expect(payload).toContain("event 1");
        expect(payload).toContain("event 2");
    });
});
