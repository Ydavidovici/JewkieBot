import {ApiTransport} from "./apiTransport.js";

export class chessComClient {
    async fetchPlayer(player) {
        return await new ApiTransport({baseUrl: "https://api.chess.com/pub/"}).get(`player/${player}`);
    }
}