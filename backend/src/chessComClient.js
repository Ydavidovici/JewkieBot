import {ApiTransport} from "./apiTransport.js";

// TODO: migrate to ts

export class chessComClient {
    constructor() {
        this.api = new ApiTransport({
            baseUrl: "https://api.chess.com/pub/",
            defaultHeaders: {
                "User-Agent": "JewkieBot Backend (Development)"
            }
        });
    }

    async fetchPlayer(player) {
        return await this.api.get(`player/${player}`);
    }

    async fetchArchives(player) {
        return await this.api.get(`player/${player}/games/archives`);
    }

    async fetchGamesForMonth(archiveUrl) {
        return await this.api.get(archiveUrl);
    }

    async fetchRecentGames(player, months = 1) {
        const archivesData = await this.fetchArchives(player);
        const archives = archivesData?.archives || [];
        
        if (archives.length === 0) return [];

        const recentArchives = archives.slice(-months);
        let allGames = [];

        for (const url of recentArchives) {
            const data = await this.fetchGamesForMonth(url);
            if (data && data.games) {
                allGames = allGames.concat(data.games);
            }
        }

        return allGames;
    }
}