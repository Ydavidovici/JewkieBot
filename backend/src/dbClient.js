async function fetchApi(endpoint, options = {}) {
    const BASE_URL = process.env.DB_SERVICE_URL || "http://localhost:4001/api/v1/chess";
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...options.headers,
        },
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API Error: ${res.status} ${res.statusText} - ${text}`);
    }

    const json = await res.json();
    return json.data !== undefined ? json.data : json;
}

export const dbClient = {
    async createGame(payload) {
        return await fetchApi("/games", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },

    async createGamesBulk(payloads) {
        return await fetchApi("/games/bulk", {
            method: "POST",
            body: JSON.stringify(payloads),
        });
    },

    async updateGame(id, payload) {
        return await fetchApi(`/games/${id}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        });
    },

    async getUnanalyzedGames() {
        return await fetchApi("/games/unanalyzed");
    },

    async getGameMoves(id) {
        return await fetchApi(`/games/${id}/moves`);
    },

    async insertGameMoves(id, moves) {
        return await fetchApi(`/games/${id}/moves/bulk`, {
            method: "POST",
            body: JSON.stringify(moves),
        });
    },

    async insertMovesBulk(moves) {
        return await fetchApi(`/moves/bulk`, {
            method: "POST",
            body: JSON.stringify(moves),
        });
    },

    async insertMoveEvals(id, evals) {
        return await fetchApi(`/games/${id}/evals/bulk`, {
            method: "POST",
            body: JSON.stringify(evals),
        });
    },

    async getStats() {
        return await fetchApi("/stats");
    }
};
