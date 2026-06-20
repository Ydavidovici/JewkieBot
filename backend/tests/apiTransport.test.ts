import {expect, test, mock, describe, beforeEach, afterEach} from "bun:test";
import {ApiTransport} from "../src/apiTransport.js";

describe("ApiTransport", () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test("prepends baseUrl if endpoint is relative", async () => {
        const fetchMock = mock(async () => ({
            ok: true,
            headers: new Headers(),
            text: async () => "ok"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport({ baseUrl: "https://api.example.com" });
        await api.get("/users");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/users");
    });

    test("does not prepend baseUrl if endpoint is absolute", async () => {
        const fetchMock = mock(async () => ({
            ok: true,
            headers: new Headers(),
            text: async () => "ok"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport({ baseUrl: "https://api.example.com" });
        await api.get("http://other.com/data");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe("http://other.com/data");
    });

    test("sets default headers and auth token", async () => {
        const fetchMock = mock(async () => ({
            ok: true,
            headers: new Headers(),
            text: async () => "ok"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport({ 
            baseUrl: "https://api.example.com", 
            token: "secret-token",
            defaultHeaders: { "X-Custom": "value" }
        });
        await api.get("/test", { headers: { "X-Override": "yes" } });

        const opts = fetchMock.mock.calls[0][1];
        expect(opts.headers["Authorization"]).toBe("Bearer secret-token");
        expect(opts.headers["X-Custom"]).toBe("value");
        expect(opts.headers["X-Override"]).toBe("yes");
    });

    test("automatically stringifies JSON objects and sets Content-Type", async () => {
        const fetchMock = mock(async () => ({
            ok: true,
            headers: new Headers(),
            text: async () => "ok"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport();
        await api.post("http://test.com/post", { foo: "bar" });

        const opts = fetchMock.mock.calls[0][1];
        expect(opts.method).toBe("POST");
        expect(opts.headers["Content-Type"]).toBe("application/json");
        expect(opts.body).toBe('{"foo":"bar"}');
    });

    test("automatically parses JSON response if content-type is json", async () => {
        const fetchMock = mock(async () => ({
            ok: true,
            headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
            json: async () => ({ hello: "world" })
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport();
        const data = await api.get("http://test.com/json");

        expect(data).toEqual({ hello: "world" });
    });

    test("returns text if response is not JSON", async () => {
        const fetchMock = mock(async () => ({
            ok: true,
            headers: new Headers({ "content-type": "text/plain" }),
            text: async () => "plain text"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport();
        const data = await api.get("http://test.com/text");

        expect(data).toBe("plain text");
    });

    test("throws an error if response is not ok", async () => {
        const fetchMock = mock(async () => ({
            ok: false,
            status: 404,
            headers: new Headers(),
            text: async () => "Not Found"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport();
        
        expect(api.get("http://test.com/404")).rejects.toThrow("HTTP 404: Not Found");
    });
    test("does not stringify URLSearchParams and does not set Content-Type to JSON", async () => {
        const fetchMock = mock(async () => ({
            ok: true,
            headers: new Headers(),
            text: async () => "ok"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport();
        const params = new URLSearchParams({ a: "1", b: "2" });
        await api.post("http://test.com/post", params);

        const opts = fetchMock.mock.calls[0][1];
        expect(opts.headers["Content-Type"]).toBeUndefined(); // fetch sets this natively for URLSearchParams
        expect(opts.body).toBeInstanceOf(URLSearchParams);
    });

    test("returns raw response if rawResponse is true", async () => {
        const rawRes = { ok: true, isRaw: true };
        const fetchMock = mock(async () => rawRes);
        global.fetch = fetchMock;

        const api = new ApiTransport();
        const data = await api.get("http://test.com/raw", { rawResponse: true });

        expect(data).toBe(rawRes);
    });

    test("does not throw if throwOnError is false", async () => {
        const fetchMock = mock(async () => ({
            ok: false,
            status: 429,
            headers: new Headers(),
            text: async () => "Rate Limited"
        }));
        global.fetch = fetchMock;

        const api = new ApiTransport();
        const data = await api.get("http://test.com/429", { throwOnError: false, rawResponse: true });

        expect(data.status).toBe(429);
    });
});
