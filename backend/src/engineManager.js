import {spawn} from "bun";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {EventEmitter} from "node:events";
import {nullNotifier} from "./notifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENGINE_PATH = path.join(__dirname, "..", "..", "engines", "myengine", "build", "myengine");

export class EngineCapReached extends Error {
    constructor(cap, current) {
        super(`Engine spawn cap reached (${current}/${cap})`);
        this.name = "EngineCapReached";
        this.cap = cap;
        this.current = current;
    }
}

export class UciEngine extends EventEmitter {
    constructor(cmd = ENGINE_PATH, options = {}) {
        super();
        this.cmd = cmd;
        this.process = null;
        this.ready = false;
        this.queue = [];
        this.restarts = 0;
        this.maxRestarts = options.maxRestarts ?? 5;
        this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 2000;
        this.restartDelayMs = options.restartDelayMs ?? 1000;
        this.commandTimeoutBufferMs = options.commandTimeoutBufferMs ?? 2000;
        this.spawnFn = options.spawnFn ?? spawn;
        this.isShuttingDown = false;
        this.notifier = options.notifier ?? nullNotifier;
        this.label = options.label ?? "engine";
        this.bookPath = options.bookPath ?? null;
    }

    async ensureReady() {
        if (!this.ready) await this.start();
    }

    // start spawns an engine
    async start() {
        if (this.process) return;
        this.isShuttingDown = false;

        try {
            console.log(`[Engine] Spawning: ${this.cmd}`);
            this.process = this.spawnFn({
                cmd: [this.cmd],
                stdin: "pipe",
                stdout: "pipe",
                stderr: "inherit",
            });

            if (!this.process.pid) throw new Error("Failed to spawn engine process.");

            this._readLoop().catch((err) => {
                console.error("[Engine Error] readLoop crashed:", err);
                this._handleCrash();
            });

            await this._sendCommand("uci", (line) => line === "uciok", null, this.handshakeTimeoutMs);
            
            if (this.bookPath) {
                await this._sendRaw(`setoption name OwnBook value true`);
                await this._sendRaw(`setoption name BookFile value ${this.bookPath}`);
            }

            await this._sendCommand("isready", (line) => line === "readyok", null, this.handshakeTimeoutMs);

            this.ready = true;
            this.restarts = 0;
            console.log("[Engine] Ready and Listening.");

        } catch (error) {
            console.error("[Engine Critical] Start failed:", error);
            this._handleCrash();
            throw error;
        }
    }

    // go tells the engine to start calculating
    async go(options = {}) {
        await this.ensureReady();

        const parts = ["go"];
        if (options.depth) parts.push(`depth ${options.depth}`);
        
        if (options.moveTime) {
            parts.push(`movetime ${options.moveTime}`);
        } else {
            if (options.whiteTime != null) parts.push(`wtime ${options.whiteTime}`);
            if (options.blackTime != null) parts.push(`btime ${options.blackTime}`);
            if (options.whiteInc != null) parts.push(`winc ${options.whiteInc}`);
            if (options.blackInc != null) parts.push(`binc ${options.blackInc}`);
            if (options.movesToGo != null) parts.push(`movestogo ${options.movesToGo}`);
        }

        // Watchdog must outlast the engine's worst-case think time. For a
        // fixed movetime that's the budget; for a real clock the engine caps a
        // single move at ~MAX_FRACTION of its remaining time, so allow the
        // larger of the two clocks (we don't know our colour here) with margin.
        const clockMax = Math.max(options.whiteTime || 0, options.blackTime || 0);
        let safeTimeout;
        if (options.moveTime) {
            safeTimeout = options.moveTime + this.commandTimeoutBufferMs;
        } else if (clockMax > 0) {
            safeTimeout = Math.ceil(clockMax * 0.9) + this.commandTimeoutBufferMs;
        } else {
            safeTimeout = 60000;
        }
        let currentBestMove = "(none)";

        try {
            const response = await this._sendCommand(
                parts.join(" "),
                (line) => line.startsWith("bestmove"),
                (line) => {
                    if (line.startsWith("info") && line.includes(" pv ")) {
                        const moves = line.split(" pv ")[1]?.split(" ");
                        if (moves && moves[0]) currentBestMove = moves[0];
                    }
                },
                safeTimeout,
            );
            return response.split(" ")[1];
        } catch (e) {
            console.error("[Engine] Error during 'go':", e);
            return currentBestMove !== "(none)" ? currentBestMove : "0000";
        }
    }

    // stop shuts down an engine
    async stop() {
        this.isShuttingDown = true;
        this.ready = false;

        if (this.process) {
            try {
                await this._sendRaw("quit");
                await new Promise(r => setTimeout(r, 100));
            } catch (_) {
            }

            this.process.kill();
            this.process = null;
        }
        console.log("[Engine] Stopped.");
    }

    async _handleCrash() {
        if (this.isShuttingDown) return;
        this.ready = false;
        this.process = null;

        if (this.queue.length > 0) {
            console.warn(`[Engine] Clearing ${this.queue.length} pending commands due to crash.`);
            this.queue.forEach(task => task.reject(new Error("Engine crashed")));
            this.queue = [];
        }

        if (this.restarts < this.maxRestarts) {
            this.restarts++;
            console.warn(`[Engine ${this.label}] Crashed (${this.restarts}/${this.maxRestarts})`);
            this.notifier.warn(`[EngineManager] Engine ${this.label} crashed`, {restart: `${this.restarts}/${this.maxRestarts}`});
            await new Promise(r => setTimeout(r, this.restartDelayMs));
            this.start().catch(e => {
                console.error(`[Engine ${this.label}] Restart failed:`, e);
                this.notifier.error(`[EngineManager] Engine ${this.label} restart failed`, {message: e?.message});
            });
        } else {
            console.error(`[Engine ${this.label}] Max restarts exceeded`);
            this.notifier.error(`[EngineManager] Engine ${this.label} exceeded max restarts`, {max: this.maxRestarts});
            this.emit("fatal_error", new Error("Max restarts exceeded"));
        }
    }

    async _sendRaw(cmd) {
        if (!this.process) throw new Error("Engine not running");
        try {
            this.process.stdin.write(cmd + "\n");
            this.process.stdin.flush();
        } catch (err) {
            this._handleCrash();
            throw err;
        }
    }

    _sendCommand(command, stopCondition, callback, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            const task = {
                command,
                donePredicate: stopCondition,
                callback: callback,
                resolve: (val) => {
                    clearTimeout(timer);
                    resolve(val);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            };

            const timer = setTimeout(() => {
                console.error(`[Engine] Command '${command}' timed out. Engine is hung.`);
                this._handleCrash();
                reject(new Error(`TIMEOUT: ${command}`));
            }, timeoutMs);

            this.queue.push(task);

            this._sendRaw(command).catch(err => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    async _readLoop() {
        if (!this.process) return;
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            for await (const chunk of this.process.stdout) {
                buffer += decoder.decode(chunk);
                let idx;

                while ((idx = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);

                    if (!line || this.queue.length === 0) continue;

                    const currentTask = this.queue[0];
                    if (currentTask.callback) currentTask.callback(line);

                    if (currentTask.donePredicate(line)) {
                        this.queue.shift();
                        currentTask.resolve(line);
                    }
                }
            }
        } catch (err) {
            console.error("[Engine] stdout stream error:", err);
            throw err;
        } finally {
            this._handleCrash();
        }
    }

    async uciNewGame() {
        await this.ensureReady();
        await this._sendRaw("ucinewgame");
        await this._sendCommand("isready", (line) => line === "readyok");
    }

    async setOption(name, value) {
        await this.ensureReady();
        const valueStr = value !== undefined && value !== null && value !== "" ? ` value ${value}` : "";
        await this._sendRaw(`setoption name ${name}${valueStr}`);
    }

    async position(fen, moves = []) {
        await this.ensureReady();
        let cmd = fen === "startpos" ? "position startpos" : `position fen ${fen}`;
        if (moves.length > 0) cmd += ` moves ${moves.join(" ")}`;
        await this._sendRaw(cmd);
    }

    async goWithEval(options = {}) {
        await this.ensureReady();

        const parts = ["go"];
        if (options.depth)    parts.push(`depth ${options.depth}`);
        if (options.moveTime) parts.push(`movetime ${options.moveTime}`);

        // For depth-based analysis allow up to 5 minutes; movetime gets the normal buffer.
        const safeTimeout = options.moveTime
            ? options.moveTime + this.commandTimeoutBufferMs
            : 300_000;

        let scoreCp = null;
        let isMate  = false;
        let bestMove = null;

        try {
            const response = await this._sendCommand(
                parts.join(" "),
                (line) => line.startsWith("bestmove"),
                (line) => {
                    if (!line.startsWith("info")) return;
                    if (line.includes("multipv") && !line.includes("multipv 1")) return;
                    // Skip aspiration-window bounds — only use exact scores.
                    if (line.includes("lowerbound") || line.includes("upperbound")) return;

                    const cpMatch   = line.match(/\bscore cp (-?\d+)/);
                    const mateMatch = line.match(/\bscore mate (-?\d+)/);
                    const pvMatch   = line.match(/\bpv (\S+)/);

                    if (cpMatch) {
                        scoreCp = parseInt(cpMatch[1], 10);
                        isMate  = false;
                    } else if (mateMatch) {
                        const n = parseInt(mateMatch[1], 10);
                        // Encode mate distances as large cp values so CPL math still works.
                        scoreCp = n > 0 ? 30_000 - n : -(30_000 + n);
                        isMate  = true;
                    }
                    if (pvMatch) bestMove = pvMatch[1];
                },
                safeTimeout,
            );
            const move = response.split(" ")[1];
            return {bestMove: move || bestMove, scoreCp, isMate};
        } catch (e) {
            console.error("[Engine] Error during 'goWithEval':", e);
            return {bestMove: bestMove ?? "0000", scoreCp, isMate};
        }
    }

    async bench(options = {}) {
        await this.ensureReady();

        const parts = ["bench"];
        if (options.depth) parts.push(`depth ${options.depth}`);
        if (options.evalTime) parts.push(`eval ${options.evalTime}`);
        if (options.mode === "time" && options.timeLimit) parts.push(`movetime ${options.timeLimit}`);

        const results = {nps: 0, eps: 0, nodes: 0, time: 0, ordering: 0, qSearch: 0, ttHit: 0, fullOutput: []};
        const predictedTimeout = options.timeLimit ? (options.timeLimit * 2) : 60000;

        await this._sendCommand(
            parts.join(" "),
            (line) => line.includes("Benchmark Complete"),
            (line) => {
                results.fullOutput.push(line);
                const parseVal = (str) => parseFloat(str.split(":")[1]?.trim().replace("%", "") || 0);

                if (line.includes("Global NPS:")) results.nps = parseInt(line.split(":")[1].trim(), 10);
                if (line.includes("EPS:")) results.eps = parseInt(line.split(":")[1].trim(), 10);
                if (line.includes("Total Nodes:")) results.nodes = parseInt(line.split(":")[1].trim(), 10);
                if (line.includes("Move Ordering:")) results.ordering = parseVal(line);
                if (line.includes("Q-Search Load:")) results.qSearch = parseVal(line);
                if (line.includes("TT Hit Rate:")) results.ttHit = parseVal(line);
            },
            predictedTimeout,
        );
        return results;
    }
}

export class EngineManager {
    constructor(options = {}) {
        this.engines = new Map();
        this.engineOptions = options.engineOptions ?? {};
        this.maxEngines = options.maxEngines ?? Infinity;
        this.notifier = options.notifier ?? nullNotifier;
    }

    count() {
        return this.engines.size;
    }

    hasCapacity() {
        return this.engines.size < this.maxEngines;
    }

    // Build an unstarted engine, reserving a slot. Caller starts it (and is
    // responsible for calling releaseSlot() on start failure if they don't
    // want the slot held).
    reserveEngine(label, enginePath) {
        if (!this.hasCapacity()) {
            this.notifier.warn("[EngineManager] Engine cap reached — rejecting spawn", {
                active: this.count(),
                cap: this.maxEngines,
                current: this.engines.size,
                requested: label,
            });
            throw err;
        }

        const engine = new UciEngine(enginePath, {
            ...this.engineOptions,
            notifier: this.notifier,
            label,
        });
        return engine;
    }

    async registerEngine(id, enginePath) {
        if (this.engines.has(id)) {
            console.warn(`[Manager] Engine ${id} is already registered.`);
            return this.engines.get(id);
        }

        const engine = this.reserveEngine(id, enginePath);

        engine.on("fatal_error", (err) => {
            console.error(`[Manager] Engine ${id} died permanently:`, err);
            this.notifier.error(`[EngineManager] Engine ${id} died permanently`, {message: err?.message});
            this.engines.delete(id);
        });

        try {
            await engine.start();
        } catch (err) {
            this.notifier.error(`[EngineManager] Engine ${id} failed to start`, {message: err?.message});
            throw err;
        }

        this.engines.set(id, engine);
        console.log(`[Manager] Engine registered: ${id}`);
        this.notifier.info(`[EngineManager] Engine registered: ${id}`, {active: this.engines.size});
        return engine;
    }

    getEngine(id) {
        if (!this.engines.has(id)) throw new Error(`Engine ${id} not found.`);
        return this.engines.get(id);
    }

    async shutdownEngine(id) {
        const engine = this.engines.get(id);
        if (engine) {
            this.engines.delete(id);
            await engine.stop().catch(e => {
                console.error(`[Manager] Error stopping engine ${id}:`, e);
                this.notifier.warn(`[EngineManager] Error stopping engine ${id}`, {message: e?.message});
            });
        }
    }

    async shutdownAll() {
        console.log(`[Manager] Shutting down all ${this.engines.size} engines...`);

        const stopPromises = Array.from(this.engines.values()).map(engine =>
            engine.stop().catch(e => {
                console.error("[Manager] Error during mass shutdown:", e);
                this.notifier.warn("[EngineManager] Error during mass shutdown", {message: e?.message});
            })
        );

        this.engines.clear();

        await Promise.allSettled(stopPromises);
        console.log("[Manager] All engines shut down successfully.");
    }
}