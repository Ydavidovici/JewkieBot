import { Chess } from "chess.js";

export class PgnGenerator {
    constructor(dbClient) {
        this.dbClient = dbClient;
    }

    async ingestPgnString(pgnContent) {
        // Handle empty or whitespace
        if (!pgnContent || pgnContent.trim() === "") {
            return { success: 0, failed: 0 };
        }

        // Split by [Event to get individual games.
        // If the file doesn't use [Event (rare), this might fail, but standard PGNs use it.
        const chunks = pgnContent.split("[Event ");
        const games = [];
        for (const c of chunks) {
            if (c.trim().length > 0) {
                games.push("[Event " + c);
            }
        }

        let success = 0;
        let failed = 0;

        for (let i = 0; i < games.length; i++) {
            const gameText = games[i];
            const chess = new Chess();
            
            try {
                chess.loadPgn(gameText);
                const headers = chess.header();
                
                const gamePayload = {
                    whiteUsername: headers.White || "Unknown",
                    blackUsername: headers.Black || "Unknown",
                    env: "local",
                    source: "pgn_ingest",
                    result: headers.Result || "*",
                    timeControl: headers.TimeControl || null,
                    started_at: headers.Date ? new Date(headers.Date.replace(/\./g, "-")).toISOString() : new Date().toISOString()
                };

                const createdGame = await this.dbClient.createGame(gamePayload);
                // dbClient might return { data: { id: X } } or just { id: X }
                // Depending on fetchApi implementation
                const gameId = createdGame?.id || createdGame?.insertId;

                if (!gameId) {
                    throw new Error("Failed to get valid game ID from database.");
                }

                const history = chess.history({ verbose: true });
                const replayChess = new Chess();
                const movesPayload = [];

                for (let ply = 0; ply < history.length; ply++) {
                    const moveInfo = history[ply];
                    const uci = moveInfo.from + moveInfo.to + (moveInfo.promotion || "");
                    replayChess.move(moveInfo.san);
                    
                    movesPayload.push({
                        game_id: gameId,
                        ply: ply + 1,
                        uci: uci,
                        fen_after: replayChess.fen()
                    });
                }

                if (movesPayload.length > 0) {
                    await this.dbClient.insertGameMoves(gameId, movesPayload);
                }

                success++;
            } catch (e) {
                console.error(`Error parsing/ingesting game ${i + 1}:`, e.message);
                failed++;
            }
        }

        return { success, failed };
    }

    async generatePgn(gameIds) {
        if (!Array.isArray(gameIds)) {
            gameIds = [gameIds];
        }

        let output = "";

        for (const id of gameIds) {
            // Depending on dbClient, getGame and getGameMoves must exist
            const game = await this.dbClient.getGame(id);
            if (!game) continue;

            const moves = await this.dbClient.getGameMoves(id);
            
            const dateStr = game.started_at 
                ? new Date(game.started_at).toISOString().split("T")[0].replace(/-/g, ".") 
                : "????.??.??";

            output += `[Event "Jewkiebot DB Export"]\n`;
            output += `[Site "Local"]\n`;
            output += `[Date "${dateStr}"]\n`;
            output += `[Round "?"]\n`;
            output += `[White "${game.whiteUsername || "Unknown"}"]\n`;
            output += `[Black "${game.blackUsername || "Unknown"}"]\n`;
            output += `[Result "${game.result || "*"}"]\n`;
            if (game.timeControl) output += `[TimeControl "${game.timeControl}"]\n`;
            output += `\n`;

            const chess = new Chess();
            const moveStrings = [];

            if (moves && moves.length > 0) {
                // Assuming moves are sorted by ply
                moves.sort((a, b) => a.ply - b.ply);

                for (const move of moves) {
                    let san = move.san;
                    if (!san) {
                        try {
                            const moveObj = { from: move.uci.slice(0, 2), to: move.uci.slice(2, 4) };
                            if (move.uci.length > 4) moveObj.promotion = move.uci[4];
                            
                            const result = chess.move(moveObj);
                            san = result ? result.san : move.uci;
                        } catch (e) {
                            san = move.uci; // fallback if chess.js fails
                        }
                    } else {
                        chess.move(san);
                    }
                    
                    if (move.ply % 2 !== 0) {
                        moveStrings.push(`${Math.ceil(move.ply / 2)}. ${san}`);
                    } else {
                        moveStrings.push(san);
                    }
                }
            }
            
            output += moveStrings.join(" ") + ` ${game.result || "*"}\n\n`;
        }
        return output;
    }
}
