import {EventEmitter} from "node:events"
import {ApiTransport} from "../backend/src/apiTransport"

// Minimal notifier capability the bot depends on — satisfied by the real
// Notifier, nullNotifier, and lightweight test stubs alike.
export interface NotifierClass {
    info(subject: string, details?: unknown): void;
    warn(subject: string, details?: unknown): void;
    error(subject: string, details?: unknown): void;
    fatal(subject: string, details?: unknown): void;
}

// Minimal engine capability the bot drives per game — satisfied by UciEngine,
// SshUciEngine, and the test MockEngine. (The bot is handed one engine per
// game, not the EngineManager pool.)
export interface EngineManagerClass extends EventEmitter {
    start(): Promise<void>;
    stop(): Promise<void>;
    uciNewGame(): Promise<void>;
    setOption(name: string, value: string): Promise<void>;
    position(fen: string, moves?: string[]): Promise<void>;
    go(options: EngineGoOptions): Promise<{bestMove: string | null; scoreCp: number | null; isMate: boolean}>;
}

// Options accepted by LichessBot._lichessFetch (spread into ApiTransport.request).
export interface LichessFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface SshConfig {
    user?: string;
    host: string;
    keyPath?: string;
    stockfishPath: string;
}

export interface UciEngineOptions {
    cmd: string | string[];
    maxRestarts: number;
    handshakeTimeoutMs: number;
    restartDelayMs: number;
    commandTimeoutBufferMs: number;
    spawnFn: any;
    notifier: any;
    label: string;
    bookPath: string | null;
}

export interface EngineManagerOptions {
    engineOptions?: Partial<UciEngineOptions>;
    maxEngines?: number;
    notifier?: any;
}

// The single search contract shared by go() and bench(). Every field is
// always sent to the engine; a value of 0 means "unconstrained".
export interface EngineGoOptions {
    depth: number;
    nodes: number;
    moveTime: number;
    whiteTime: number;
    blackTime: number;
    whiteIncrement: number;
    blackIncrement: number;
}

export interface EngineCommandOptions {
    command: string;
    stopCondition?: Function;
    callback?: Function;
    timeoutMs?: number;
}

export interface ApiHealthResponse {
    status: "ok" | "error";
    engine: "ready" | "starting" | "offline";
    engineCount: number;
    botRunning: boolean;
    activeGames: number;
    uptimeSec: number;
}

export interface LichessBotOptions {
    maxConcurrentGames?: number;
    maxRestarts?: number;
    huntPollIntervalMs?: number;
    restartDelayMs?: number;
    commandTimeoutMs?: number;
    reconnectDelayMs?: number;
    notifier?: NotifierClass;
    now?: any
    huntAcceptTimeoutMs?: number
    defaultRetryAfterSec?: number
    rateLimitedUntil?: number;
    maxBotGamesUntil?: number;
    apiTransport?: ApiTransport;
    declineCooldownMs?: number;
}

export interface LichessAutoplayOptions {
    limit?: number;
    increment?: number;
    rated?: boolean;
    target?: number;
    mode?: "near" | "weakest";
    window?: number;
    whiteOpeningId?: string | null;
    blackOpeningId?: string | null;
    opponentType?: "bots" | "humans" | "both";
}

// Resolved, running autoplay state stored on the bot (options + loop bookkeeping).
export interface LichessAutoplayState {
    limit: number;
    increment: number;
    rated: boolean;
    target: number;
    mode: "near" | "weakest";
    window: number;
    whiteOpeningId: string | null;
    blackOpeningId: string | null;
    opponentType: "bots" | "humans" | "both";
    timer: ReturnType<typeof setTimeout> | null;
    huntInFlight: boolean;
}