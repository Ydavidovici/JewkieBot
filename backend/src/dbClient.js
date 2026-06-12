import {ApiTransport} from "./apiTransport.js";
import {nullNotifier} from "./notifier.js";

const transport = new ApiTransport({
    baseUrl: process.env.DB_SERVICE_URL || "http://localhost:4001/api/v1/chess",
    notifier: nullNotifier,
    unwrapData: true,
});

export const dbClient = {
    setNotifier(newNotifier) {
        transport.notifier = newNotifier || nullNotifier;
    },

    async createGame(payload) {
        return transport.post("/games", payload);
    },

    async createGamesBulk(payloads) {
        return transport.post("/games/bulk", payloads);
    },

    async updateGame(id, payload) {
        return transport.patch(`/games/${id}`, payload);
    },

    async getUnanalyzedGames() {
        return transport.get("/games/unanalyzed");
    },

    async getUnanalyzedGamesByPlayer(playerName) {
        return transport.get(`/games/player/${encodeURIComponent(playerName)}/unanalyzed`);
    },

    async getGamesByPlayer(playerName) {
        // Automatically URL-encode the player name (e.g. for spaces or special chars)
        return transport.get(`/games/player/${encodeURIComponent(playerName)}`);
    },

    async getGameMoves(id) {
        return transport.get(`/games/${id}/moves`);
    },

    async insertGameMoves(id, moves) {
        return transport.post(`/games/${id}/moves/bulk`, moves);
    },

    async insertMovesBulk(moves) {
        return transport.post(`/moves/bulk`, moves);
    },

    async insertMoveEvals(id, evals) {
        return transport.post(`/games/${id}/evals/bulk`, evals);
    },

    async getStats() {
        return transport.get("/stats");
    },
};

