import axios from "axios";

// Empty = same origin: the page calls whichever backend served it (prod on
// jewkiebot.dev, dev on dev.jewkiebot.dev). VITE_API_URL overrides for local
// Vite dev, where the frontend and backend are on different ports.
const DEFAULT_BASE_URL = import.meta.env.VITE_API_URL ?? "";

// The control API sits behind the DSS auth gatekeeper (nginx auth_request). A
// 401 means "no valid session" — the LoginGate registers a handler here and
// shows the login overlay when that happens.
let unauthorizedHandler: (() => void) | null = null;
export const onUnauthorized = (fn: () => void) => { unauthorizedHandler = fn; };

/**
 * Generic API Request Handler
 * @param {string} endpoint - The URI path (e.g., '/api/health')
 * @param {object} config - Configuration object {method, data, headers, baseUrl, ...}
 */
export const request = async (endpoint, {method = "GET", data, headers = {}, baseUrl = null, ...customConfig} = {}) => {
    try {
        const targetUrl = baseUrl || DEFAULT_BASE_URL;
        const response = await axios({
            url: `${targetUrl}${endpoint}`,
            method,
            data,
            withCredentials: true,   // send/receive the auth session cookie
            headers: {
                "Content-Type": "application/json",
                ...headers,
            },
            ...customConfig,
        });

        return response.data;
    } catch (error) {
        if (error?.response?.status === 401) unauthorizedHandler?.();
        console.error(`API Request failed: ${method} ${endpoint} against ${baseUrl || DEFAULT_BASE_URL}`, error);
        throw error;
    }
};

export const login = (email, password, baseUrl = null) =>
    request("/api/auth/login", { method: "POST", data: { email, password }, baseUrl });

export const logout = (baseUrl = null) =>
    request("/api/auth/logout", { method: "POST", baseUrl });

export const startGame = (player1_id, player2_id, baseUrl = null) =>
    request("/api/start_game", {
        method: "POST",
        data: {player1_id, player2_id},
        baseUrl
    });

export const makeMove = (fen, move, baseUrl = null) =>
    request("/api/engine/make-move", {
        method: "POST",
        data: {fen, move},
        baseUrl
    });

export const getGameStatus = (game_id, baseUrl = null) =>
    request(`/api/game-status/${game_id}`, {
        method: "GET",
        baseUrl
    });

export const health = (baseUrl = null) =>
    request("/api/health", {
        method: "GET",
        baseUrl
    });

export const bestMove = ({fen, moves, depth, movetime}, baseUrl = null) =>
    request("/api/engine/best-move", {
        method: "POST",
        data: {fen, moves, depth, movetime},
        baseUrl
    });

export const printPosition = (fen, baseUrl = null) =>
    request("/api/engine/print-position", {
        method: "POST",
        data: {fen},
        baseUrl
    });

export const runBenchmark = (options, baseUrl = null) =>
    request("/api/engine/bench", {
        method: "POST",
        data: options,
        baseUrl
    });

export const cancelBenchmark = async (baseUrl = null) => {
    await request(`/api/engine/cancel`, {method: "POST", baseUrl});
};

export const go = ({fen, moves, options}, baseUrl = null) =>
    request("/api/engine/go", {
        method: "POST",
        data: {fen, moves, options},
        baseUrl
    });

export const resetGame = (baseUrl = null) =>
    request("/api/engine/reset", {
        method: "POST",
        baseUrl
    });

export const analyze = (fen, depth = 10, baseUrl = null) =>
    request("/api/engine/analysis", {
        method: "POST",
        data: {fen, depth},
        baseUrl
    });

export const startLichessBot = (token, baseUrl = null) =>
    request("/api/lichess/start", {
        method: "POST",
        data: { token },
        baseUrl
    });

export const stopLichessBot = (baseUrl = null) =>
    request("/api/lichess/stop", {
        method: "POST",
        baseUrl
    });

export const getLichessStatus = (baseUrl = null) =>
    request("/api/lichess/status", {
        method: "GET",
        baseUrl
    });

export const createOpenChallenge = (limit, increment, baseUrl = null) =>
    request("/api/lichess/challenge/open", {
        method: "POST",
        data: { limit, increment },
        baseUrl
    });

export const createAiChallenge = (level, limit, increment, baseUrl = null) =>
    request("/api/lichess/challenge/ai", {
        method: "POST",
        data: { level, limit, increment },
        baseUrl
    });

export const createChallenge = (username, limit, increment, baseUrl = null) =>
    request("/api/lichess/challenge", {
        method: "POST",
        data: { username, limit, increment },
        baseUrl
    });

export const challengeWeakestBot = (limit, increment, baseUrl = null) =>
    request("/api/lichess/challenge/weakest", {
        method: "POST",
        data: { limit, increment },
        baseUrl
    });

// --- Autoplay Endpoints ---
export const startAutoplay = (options, baseUrl = null) =>
    request("/api/lichess/autoplay/start", {
        method: "POST",
        data: options,
        baseUrl
    });

export const stopAutoplay = (baseUrl = null) =>
    request("/api/lichess/autoplay/stop", {
        method: "POST",
        baseUrl
    });

export const getAutoplayStatus = (baseUrl = null) =>
    request("/api/lichess/autoplay/status", {
        method: "GET",
        baseUrl
    });

export const getOpenings = (baseUrl = null) =>
    request("/api/openings", {
        method: "GET",
        baseUrl
    });

export const setEngineOption = (name, value, baseUrl = null) =>
    request("/api/engine/setoption", {
        method: "POST",
        data: { name, value },
        baseUrl
    });

// --- Self-Play Endpoints ---
export const getSelfPlayVersions = (baseUrl = null) =>
    request("/api/selfplay/versions", {
        method: "GET",
        baseUrl
    });

export const runSelfPlay = (options, baseUrl = null) =>
    request("/api/selfplay/run", {
        method: "POST",
        data: options,
        baseUrl
    });

// A run's games for replay: the live run if still in memory, else the archived
// PGN of a finished run. Returns { status, running, elo, progress, games }.
export const getSelfPlayGames = (taskId, baseUrl = null) =>
    request(`/api/selfplay/games/${taskId}`, {
        method: "GET",
        baseUrl
    });

export const getRecentGames = (limit = 10, dbUrl = null) =>
    request(`/api/v1/chess/games/recent?limit=${limit}`, {
        method: "GET",
        baseUrl: dbUrl || import.meta.env.VITE_DB_URL || ""
    });

export const getGameEvals = (gameId, dbUrl = null) =>
    request(`/api/v1/chess/games/${gameId}/evals`, {
        method: "GET",
        baseUrl: dbUrl || import.meta.env.VITE_DB_URL || ""
    });

export const getGameMoves = (gameId, dbUrl = null) =>
    request(`/api/v1/chess/games/${gameId}/moves`, {
        method: "GET",
        baseUrl: dbUrl || import.meta.env.VITE_DB_URL || ""
    });