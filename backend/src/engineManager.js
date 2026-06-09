import {spawn} from "bun";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {EventEmitter} from "node:events";
import {nullNotifier} from "./notifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENGINE_PATH = path.join(__dirname, "..", "..", "engines", "jewkiebot", "build", "jewkiebot");

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
            const cmdArray = Array.isArray(this.cmd) ? this.cmd : [this.cmd];
            console.log(`[Engine] Spawning: ${cmdArray.join(" ")}`);
            this.process = this.spawnFn({
                cmd: cmdArray,
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
        if (options.depth)    parts.push(`depth ${options.depth}`);
        if (options.nodes)    parts.push(`nodes ${options.nodes}`);

        if (options.moveTime) {
            parts.push(`movetime ${options.moveTime}`);
        } else {
            if (options.whiteTime) parts.push(`wtime ${options.whiteTime}`);
            if (options.blackTime) parts.push(`btime ${options.blackTime}`);
            if (options.whiteInc  != null) parts.push(`winc ${options.whiteInc}`);
            if (options.blackInc  != null) parts.push(`binc ${options.blackInc}`);
        }

        let safeTimeout = options.moveTime ? options.moveTime + this.commandTimeoutBufferMs : (options.whiteTime ? 60000 * 5 : 60000);
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

    async goWithEval(options = {}) {
        await this.ensureReady();

        const parts = ["go"];
        if (options.depth)    parts.push(`depth ${options.depth}`);
        if (options.nodes)    parts.push(`nodes ${options.nodes}`);

        if (options.moveTime) {
            parts.push(`movetime ${options.moveTime}`);
        } else {
            if (options.whiteTime) parts.push(`wtime ${options.whiteTime}`);
            if (options.blackTime) parts.push(`btime ${options.blackTime}`);
            if (options.whiteInc  != null) parts.push(`winc ${options.whiteInc}`);
            if (options.blackInc  != null) parts.push(`binc ${options.blackInc}`);
        }

        let safeTimeout = options.moveTime ? options.moveTime + this.commandTimeoutBufferMs : (options.whiteTime ? 60000 * 5 : 60000);
        let currentBestMove = "(none)";
        let scoreCp = null;
        let isMate = false;

        try {
            const response = await this._sendCommand(
                parts.join(" "),
                (line) => line.startsWith("bestmove"),
                (line) => {
                    if (line.startsWith("info")) {
                        if (line.includes(" score cp ")) {
                            const match = line.match(/score cp (-?\d+)/);
                            if (match) {
                                scoreCp = parseInt(match[1], 10);
                                isMate = false;
                            }
                        } else if (line.includes(" score mate ")) {
                            const match = line.match(/score mate (-?\d+)/);
                            if (match) {
                                scoreCp = parseInt(match[1], 10) > 0 ? 10000 : -10000;
                                isMate = true;
                            }
                        }
                        if (line.includes(" pv ")) {
                            const moves = line.split(" pv ")[1]?.split(" ");
                            if (moves && moves[0]) currentBestMove = moves[0];
                        }
                    }
                },
                safeTimeout,
            );
            return {
                bestMove: response.split(" ")[1] || currentBestMove,
                scoreCp,
                isMate
            };
        } catch (e) {
            console.error("[Engine] Error during 'goWithEval':", e);
            return { bestMove: currentBestMove !== "(none)" ? currentBestMove : "0000", scoreCp: null, isMate: false };
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

                    if (!line) continue;
                    this.emit("line", line);

                    if (this.queue.length === 0) continue;

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
            throw new Error(`Engine spawn cap reached (${this.engines.size}/${this.maxEngines})`);
        }

        let engine;
        if (process.env.REMOTE_ENGINE_ENABLED === "true") {
            const sshConfig = {
                user: process.env.REMOTE_SSH_USER,
                host: process.env.REMOTE_SSH_HOST,
                keyPath: process.env.REMOTE_SSH_KEY_PATH,
                stockfishPath: process.env.REMOTE_STOCKFISH_PATH
            };
            engine = new SshUciEngine(sshConfig, {
                ...this.engineOptions,
                notifier: this.notifier,
                label,
            });
        } else {
            engine = new UciEngine(enginePath, {
                ...this.engineOptions,
                notifier: this.notifier,
                label,
            });
        }
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

export class SshUciEngine extends UciEngine {
    constructor(sshConfig, options = {}) {
        const cmd = ["ssh"];
        if (sshConfig.keyPath) cmd.push("-i", sshConfig.keyPath);
        cmd.push("-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30");
        const target = sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host;
        cmd.push(target, sshConfig.stockfishPath);
        super(cmd, options);
        this.sshConfig = sshConfig;
    }

    async _handleCrash() {
        if (!this.isShuttingDown) {
            console.warn(`[SshUciEngine ${this.label}] SSH connection dropped or process crashed.`);
        }
        await super._handleCrash();
    }
}