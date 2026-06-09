import { Chess } from "chess.js";
import fs from "node:fs";

export class PgnManager {
    constructor(dbClient) {
        this.dbClient = dbClient;
    }

    _splitPgn(pgnContent) {
        if (!pgnContent || pgnContent.trim() === "") return [];
        const chunks = pgnContent.split("[Event ");
        const games = [];
        for (const c of chunks) {
            if (c.trim().length > 0) {
                games.push("[Event " + c);
            }
        }
        return games;
    }

    async ingestPgnFile(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return await this.ingestPgnString(content);
    }

    async ingestPgnString(pgnContent) {
        const gamesText = this._splitPgn(pgnContent);
        if (gamesText.length === 0) return { success: 0, failed: 0 };

        const gamesPayload = [];
        const parsedGames = [];

        for (let i = 0; i < gamesText.length; i++) {
            const gameText = gamesText[i];
            const chess = new Chess();
            
            try {
                chess.loadPgn(gameText);
                const headers = chess.header();
                
                gamesPayload.push({
                    _bulkIndex: i, // Correlation ID
                    whiteUsername: headers.White || "Unknown",
                    blackUsername: headers.Black || "Unknown",
                    env: "local",
                    source: "pgn_ingest",
                    result: headers.Result || "*",
                    timeControl: headers.TimeControl || null,
                    started_at: headers.Date ? new Date(headers.Date.replace(/\./g, "-")).toISOString() : new Date().toISOString()
                });

                parsedGames.push({ index: i, history: chess.history({ verbose: true }), startFen: headers.FEN });
            } catch (e) {
                console.error(`Error parsing game ${i + 1}:`, e.message);
            }
        }

        if (gamesPayload.length === 0) return { success: 0, failed: 0 };

        console.log(`Sending bulk create request for ${gamesPayload.length} games...`);
        const createdGames = await this.dbClient.createGamesBulk(gamesPayload);

        const allMovesPayload = [];
        let success = 0;
        let failed = 0;

        for (const cg of createdGames) {
            const bulkIndex = cg._bulkIndex;
            const parsed = parsedGames.find(p => p.index === bulkIndex);
            if (!parsed || !cg.id) {
                failed++;
                continue;
            }

            const startFen = parsed.startFen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
            const replayChess = new Chess(startFen);
            for (let ply = 0; ply < parsed.history.length; ply++) {
                const moveInfo = parsed.history[ply];
                const uci = moveInfo.from + moveInfo.to + (moveInfo.promotion || "");
                replayChess.move(moveInfo.san);
                
                allMovesPayload.push({
                    game_id: cg.id,
                    ply: ply + 1,
                    uci: uci,
                    fen_after: replayChess.fen()
                });
            }
            success++;
        }

        // We can optimize the moves insert as well if dbClient supports it
        if (allMovesPayload.length > 0) {
            console.log(`Sending bulk create request for ${allMovesPayload.length} total moves...`);
            const chunkSize = 500; // Small enough to bypass Express's default 100kb JSON body limit
            for (let i = 0; i < allMovesPayload.length; i += chunkSize) {
                const chunk = allMovesPayload.slice(i, i + chunkSize);
                await this.dbClient.insertMovesBulk(chunk);
            }
        }

        return { success, failed };
    }

    parsePgnToEpd(pgnContent) {
        const games = this._splitPgn(pgnContent);
        const epdLines = [];
        let positionCount = 0;
        let gameCount = 0;

        for (const pgn of games) {
            const chess = new Chess();
            try {
                chess.loadPgn(pgn);
            } catch(err) {
                continue;
            }

            let resultHeader = chess.header().Result;
            let resultLabel = "0.5";
            if (resultHeader === "1-0") resultLabel = "1.0";
            if (resultHeader === "0-1") resultLabel = "0.0";
            
            if (resultHeader === "*" || !resultHeader) continue;

            const history = chess.history();
            const startFen = chess.header().FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
            const tempChess = new Chess(startFen);
            
            for (let i = 0; i < history.length; i++) {
                tempChess.move(history[i]);
                if (i > 11) {
                    if (!tempChess.inCheck()) {
                        epdLines.push(`${tempChess.fen()} c9 "${resultLabel}"`);
                        positionCount++;
                    }
                }
            }
            gameCount++;
        }

        return { epdLines, positionCount, gameCount };
    }

    async generatePgn(gameIds) {
        if (!Array.isArray(gameIds)) gameIds = [gameIds];
        let output = "";

        for (const id of gameIds) {
            const game = await this.dbClient.getGame(id);
            if (!game) continue;
            const moves = await this.dbClient.getGameMoves(id);
            
            const dateStr = game.started_at 
                ? new Date(game.started_at).toISOString().split("T")[0].replace(/-/g, ".") 
                : "????.??.??";

            output += `[Event "Jewkiebot DB Export"]\n[Site "Local"]\n[Date "${dateStr}"]\n[Round "?"]\n`;
            output += `[White "${game.whiteUsername || "Unknown"}"]\n[Black "${game.blackUsername || "Unknown"}"]\n`;
            output += `[Result "${game.result || "*"}"]\n`;
            if (game.timeControl) output += `[TimeControl "${game.timeControl}"]\n`;
            output += `\n`;

            const chess = new Chess();
            const moveStrings = [];

            if (moves && moves.length > 0) {
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
                            san = move.uci;
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
