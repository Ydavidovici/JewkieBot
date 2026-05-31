import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { UciEngine, EngineManager } from "../src/engineManager.js";

function createMockProcess() {
    const stdinWrites = [];
    const stdoutQueue = [];
    let stdoutResolvers = [];
    let stdoutClosed = false;

    const stdout = (async function* () {
        while (true) {
            if (stdoutQueue.length > 0) {
                yield stdoutQueue.shift();
            } else if (stdoutClosed) {
                return;
            } else {
                await new Promise(r => stdoutResolvers.push(r));
            }
        }
    })();

    const proc = {
        pid: 12345,
        stdin: {
            write: (data) => { stdinWrites.push(data); },
            flush: () => {},
        },
        stdout,
        kill: mock(() => {}),
        exited: new Promise(() => {}),

        _stdinWrites: stdinWrites,
        _pushLine: (line) => {
            stdoutQueue.push(new TextEncoder().encode(line + "\n"));
            const r = stdoutResolvers.shift();
            if (r) r();
        },
        _close: () => {
            stdoutClosed = true;
            for (const r of stdoutResolvers) r();
            stdoutResolvers = [];
        },
    };
    return proc;
}

function makeSpawnFn() {
    const procs = [];
    const fn = mock((args) => {
        const p = createMockProcess();
        p._spawnArgs = args;
        procs.push(p);
        return p;
    });
    fn.processes = procs;
    return fn;
}

async function tick(ms = 5) {
    await new Promise(r => setTimeout(r, ms));
}

async function quickStart(engine, spawnFn) {
    const startP = engine.start();
    await tick(5);
    const proc = spawnFn.processes[spawnFn.processes.length - 1];
    proc._pushLine("uciok");
    await tick(10);
    proc._pushLine("readyok");
    await startP;
    return proc;
}

describe("UciEngine.start()", () => {
    it("spawns, exchanges uci/uciok and isready/readyok, sets ready=true", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake/engine", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(engine.ready).toBe(true);
        expect(proc._stdinWrites).toEqual(["uci\n", "isready\n"]);
    });

    it("sends 'setoption name OwnBook value true' and 'setoption name BookFile value <bookPath>' if bookPath is configured", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake/engine", { spawnFn, handshakeTimeoutMs: 200, bookPath: "/some/book.bin" });
        const proc = await quickStart(engine, spawnFn);

        expect(proc._stdinWrites).toContain("setoption name OwnBook value true\n");
        expect(proc._stdinWrites).toContain("setoption name BookFile value /some/book.bin\n");
    });

    it("throws when the spawned process has no pid", async () => {
        const spawnFn = mock(() => ({ pid: 0 }));
        const engine = new UciEngine("/fake", { spawnFn });
        await expect(engine.start()).rejects.toThrow();
    });

    it("is a no-op when called twice without stop", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        await quickStart(engine, spawnFn);
        await engine.start();  // second call: process is already set, returns immediately
        expect(spawnFn.processes).toHaveLength(1);
    });

    it("handshake timeout triggers a restart attempt", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", {
            spawnFn,
            handshakeTimeoutMs: 30,
            maxRestarts: 3,
            restartDelayMs: 5,
        });
        engine.start().catch(() => {});
        await tick(150);
        expect(spawnFn.processes.length).toBeGreaterThanOrEqual(2);
        engine.isShuttingDown = true;
    });

    it("emits fatal_error after maxRestarts is exceeded", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", {
            spawnFn,
            handshakeTimeoutMs: 20,
            maxRestarts: 1,
            restartDelayMs: 5,
        });

        const fatalErr = await new Promise(resolve => {
            engine.once("fatal_error", resolve);
            engine.start().catch(() => {});
        });

        expect(fatalErr.message).toContain("Max restarts");
        engine.isShuttingDown = true;
    });

    it("restart counter resets to 0 after a successful start", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });

        engine.restarts = 3;
        await quickStart(engine, spawnFn);
        expect(engine.restarts).toBe(0);
    });
});

describe("UciEngine.uciNewGame()", () => {
    it("sends 'ucinewgame' followed by 'isready' and waits for 'readyok'", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.uciNewGame();
        await tick();
        proc._pushLine("readyok");
        await p;

        const writes = proc._stdinWrites.slice(-2);
        expect(writes).toEqual(["ucinewgame\n", "isready\n"]);
    });
});

describe("UciEngine.position()", () => {
    it("sends 'position startpos' when fen='startpos' and no moves", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        await engine.position("startpos");
        expect(proc._stdinWrites.at(-1)).toBe("position startpos\n");
    });

    it("sends 'position fen ... moves a b' when fen and moves provided", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        await engine.position("8/8/8/8/8/8/8/8 w - - 0 1", ["e2e4", "e7e5"]);
        expect(proc._stdinWrites.at(-1)).toBe("position fen 8/8/8/8/8/8/8/8 w - - 0 1 moves e2e4 e7e5\n");
    });

    it("startpos + moves still emits 'position startpos moves ...'", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        await engine.position("startpos", ["g1f3"]);
        expect(proc._stdinWrites.at(-1)).toBe("position startpos moves g1f3\n");
    });
});

describe("UciEngine.go()", () => {
    it("sends 'go depth N' and resolves with the bestmove", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.go({ depth: 5 });
        await tick();
        proc._pushLine("info depth 5 score cp 30 pv e2e4 e7e5");
        proc._pushLine("bestmove e2e4");
        const move = await p;
        expect(move).toBe("e2e4");
        expect(proc._stdinWrites.at(-1)).toBe("go depth 5\n");
    });

    it("sends only 'go movetime X' when moveTime is provided — clock params suppressed", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.go({ whiteTime: 60000, blackTime: 50000, whiteInc: 1000, blackInc: 1000, moveTime: 500 });
        await tick();
        proc._pushLine("bestmove d2d4");
        await p;
        // movetime is mutually exclusive with clock params in UCI — only movetime should be sent
        expect(proc._stdinWrites.at(-1)).toBe("go movetime 500\n");
    });

    it("sends wtime/btime/winc/binc when no moveTime is provided", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.go({ whiteTime: 60000, blackTime: 50000, whiteInc: 1000, blackInc: 1000 });
        await tick();
        proc._pushLine("bestmove d2d4");
        await p;
        expect(proc._stdinWrites.at(-1)).toBe("go wtime 60000 btime 50000 winc 1000 binc 1000\n");
    });

    it("sends 'winc 0 binc 0' for zero-increment games (not omitted)", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.go({ whiteTime: 60000, blackTime: 60000, whiteInc: 0, blackInc: 0 });
        await tick();
        proc._pushLine("bestmove e2e4");
        await p;
        expect(proc._stdinWrites.at(-1)).toBe("go wtime 60000 btime 60000 winc 0 binc 0\n");
    });

    it("combines depth with movetime correctly", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.go({ depth: 10, moveTime: 3000 });
        await tick();
        proc._pushLine("bestmove g1f3");
        await p;
        expect(proc._stdinWrites.at(-1)).toBe("go depth 10 movetime 3000\n");
    });

    it("returns '(none)' when engine reports bestmove (none)", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.go({ depth: 1 });
        await tick();
        proc._pushLine("bestmove (none)");
        expect(await p).toBe("(none)");
    });

    it("returns the last seen PV-first move when the command times out", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", {
            spawnFn,
            handshakeTimeoutMs: 200,
            commandTimeoutBufferMs: 30,
        });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.go({ moveTime: 20 });
        await tick();
        proc._pushLine("info depth 3 pv g1f3 b8c6");
        // never send bestmove → command times out after moveTime + 30ms
        const move = await p;
        expect(move).toBe("g1f3");
        engine.isShuttingDown = true;
    });

    it("returns '0000' when the command times out and no PV was ever seen", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", {
            spawnFn,
            handshakeTimeoutMs: 200,
            commandTimeoutBufferMs: 30,
        });
        await quickStart(engine, spawnFn);

        const p = engine.go({ moveTime: 20 });
        // no info, no bestmove
        const move = await p;
        expect(move).toBe("0000");
        engine.isShuttingDown = true;
    });
});

describe("UciEngine.bench()", () => {
    it("parses NPS, EPS, nodes, ordering, qSearch, TT-hit from output", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.bench({ depth: 8 });
        await tick();
        proc._pushLine("Global NPS: 1234567");
        proc._pushLine("EPS: 999");
        proc._pushLine("Total Nodes: 50000");
        proc._pushLine("Move Ordering: 92.5%");
        proc._pushLine("Q-Search Load: 18.0%");
        proc._pushLine("TT Hit Rate: 41.2%");
        proc._pushLine("Benchmark Complete");
        const r = await p;

        expect(r.nps).toBe(1234567);
        expect(r.eps).toBe(999);
        expect(r.nodes).toBe(50000);
        expect(r.ordering).toBe(92.5);
        expect(r.qSearch).toBe(18.0);
        expect(r.ttHit).toBe(41.2);
        expect(proc._stdinWrites.at(-1)).toBe("bench depth 8\n");
    });

    it("sends 'bench movetime X' when mode='time' and timeLimit provided", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p = engine.bench({ mode: "time", timeLimit: 5000 });
        await tick();
        proc._pushLine("Benchmark Complete");
        await p;
        expect(proc._stdinWrites.at(-1)).toContain("bench movetime 5000");
    });
});

describe("UciEngine.stop()", () => {
    it("sends 'quit', kills the process, marks not ready, does not restart", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200, restartDelayMs: 5, maxRestarts: 3 });
        const proc = await quickStart(engine, spawnFn);

        await engine.stop();

        expect(engine.ready).toBe(false);
        expect(engine.isShuttingDown).toBe(true);
        expect(engine.process).toBeNull();
        expect(proc._stdinWrites).toContain("quit\n");
        expect(proc.kill).toHaveBeenCalled();

        // close the old stream now to trigger the read loop's finally (_handleCrash);
        // because isShuttingDown=true, no restart should occur.
        proc._close();
        await tick(30);
        expect(spawnFn.processes).toHaveLength(1);
    });
});

describe("UciEngine — concurrent command queue", () => {
    it("processes commands FIFO when responses arrive sequentially", async () => {
        const spawnFn = makeSpawnFn();
        const engine = new UciEngine("/fake", { spawnFn, handshakeTimeoutMs: 200 });
        const proc = await quickStart(engine, spawnFn);

        const p1 = engine.uciNewGame();
        const p2 = engine.uciNewGame();
        await tick();
        proc._pushLine("readyok"); // satisfies p1
        await p1;
        proc._pushLine("readyok"); // satisfies p2
        await p2;
        // both completed → success
    });
});

describe("EngineManager.registerEngine()", () => {
    it("creates and starts a new engine, returns it, stores it under id", async () => {
        const spawnFn = makeSpawnFn();
        const manager = new EngineManager({ engineOptions: { spawnFn, handshakeTimeoutMs: 200 } });

        const registerP = manager.registerEngine("Main", "/fake/path");
        await tick();
        spawnFn.processes[0]._pushLine("uciok");
        spawnFn.processes[0]._pushLine("readyok");
        const engine = await registerP;

        expect(engine).toBeDefined();
        expect(engine.ready).toBe(true);
        expect(manager.engines.get("Main")).toBe(engine);
        engine.stop();
    });

    it("returns the existing engine without re-spawning on duplicate id", async () => {
        const spawnFn = makeSpawnFn();
        const manager = new EngineManager({ engineOptions: { spawnFn, handshakeTimeoutMs: 200 } });

        const registerP = manager.registerEngine("Main", "/fake/path");
        await tick();
        spawnFn.processes[0]._pushLine("uciok");
        spawnFn.processes[0]._pushLine("readyok");
        const first = await registerP;

        const second = await manager.registerEngine("Main", "/different/path");
        expect(second).toBe(first);
        expect(spawnFn.processes).toHaveLength(1);
        first.stop();
    });

    it("does not add the engine to the map when start() throws", async () => {
        const spawnFn = mock(() => ({ pid: 0 }));  // pid 0 → start throws
        const manager = new EngineManager({ engineOptions: { spawnFn } });

        await expect(manager.registerEngine("BadEngine", "/fake")).rejects.toThrow();
        expect(manager.engines.has("BadEngine")).toBe(false);
    });
});

describe("EngineManager.getEngine()", () => {
    it("returns the registered engine", async () => {
        const spawnFn = makeSpawnFn();
        const manager = new EngineManager({ engineOptions: { spawnFn, handshakeTimeoutMs: 200 } });

        const p = manager.registerEngine("Main", "/fake");
        await tick();
        spawnFn.processes[0]._pushLine("uciok");
        spawnFn.processes[0]._pushLine("readyok");
        const engine = await p;

        expect(manager.getEngine("Main")).toBe(engine);
        engine.stop();
    });

    it("throws when the id is not registered", () => {
        const manager = new EngineManager();
        expect(() => manager.getEngine("NotThere")).toThrow(/not found/i);
    });
});

describe("EngineManager.shutdownEngine() and shutdownAll()", () => {
    it("shutdownEngine removes from map and calls stop()", async () => {
        const spawnFn = makeSpawnFn();
        const manager = new EngineManager({ engineOptions: { spawnFn, handshakeTimeoutMs: 200 } });

        const p = manager.registerEngine("Main", "/fake");
        await tick();
        spawnFn.processes[0]._pushLine("uciok");
        spawnFn.processes[0]._pushLine("readyok");
        await p;

        await manager.shutdownEngine("Main");
        expect(manager.engines.has("Main")).toBe(false);
    });

    it("shutdownEngine is a no-op for unknown id", async () => {
        const manager = new EngineManager();
        await expect(manager.shutdownEngine("NotThere")).resolves.toBeUndefined();
    });

    it("shutdownAll stops every registered engine and clears the map", async () => {
        const spawnFn = makeSpawnFn();
        const manager = new EngineManager({ engineOptions: { spawnFn, handshakeTimeoutMs: 200 } });

        const p1 = manager.registerEngine("E1", "/fake");
        await tick();
        spawnFn.processes[0]._pushLine("uciok");
        spawnFn.processes[0]._pushLine("readyok");
        await p1;

        const p2 = manager.registerEngine("E2", "/fake");
        await tick();
        spawnFn.processes[1]._pushLine("uciok");
        spawnFn.processes[1]._pushLine("readyok");
        await p2;

        expect(manager.engines.size).toBe(2);
        await manager.shutdownAll();
        expect(manager.engines.size).toBe(0);
    });
});

describe("EngineManager — fatal_error auto-remove", () => {
    it("removes an engine from the map when it emits fatal_error", async () => {
        const spawnFn = makeSpawnFn();
        const manager = new EngineManager({ engineOptions: { spawnFn, handshakeTimeoutMs: 200 } });

        const p = manager.registerEngine("Main", "/fake");
        await tick();
        spawnFn.processes[0]._pushLine("uciok");
        spawnFn.processes[0]._pushLine("readyok");
        const engine = await p;

        expect(manager.engines.has("Main")).toBe(true);
        engine.emit("fatal_error", new Error("died"));
        await tick();
        expect(manager.engines.has("Main")).toBe(false);
        engine.isShuttingDown = true;
    });
});
