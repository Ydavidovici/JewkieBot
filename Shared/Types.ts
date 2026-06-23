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