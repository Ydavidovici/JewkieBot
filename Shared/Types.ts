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
    engineOptions?: UciEngineOptions;
    maxEngines?: number;
    notifier?: any;
}

export interface EngineGoOptions {
    depth: number;
    nodes: number;
    evalTime: number;
    whiteTime: number;
    blackTime: number;
    whiteIncrement: number;
    blackIncrement: number;
    moveTime?: number;
    commandTimeoutBufferMs?: number;
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