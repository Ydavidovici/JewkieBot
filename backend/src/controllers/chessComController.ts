import { chessComClient } from "../chessComClient.js";

export class ChessComController {
    constructor(private pgnManager: any) {}

    fetchUserGames = async (req: any, res: any) => {
        try {
            const { username, months = 1 } = req.body;
            if (!username) {
                return res.status(400).json({ error: "username is required" });
            }

            console.log(`[Chess.com] Fetching last ${months} month(s) of games for ${username}...`);
            const client = new chessComClient();
            const games = await client.fetchRecentGames(username, months);

            if (!games || games.length === 0) {
                return res.json({ status: "success", ingested: 0, failed: 0, message: "No games found." });
            }

            console.log(`[Chess.com] Found ${games.length} games. Ingesting into DB...`);
            
            const pgnStrings = games.map((g: any) => g.pgn).filter(Boolean);
            const combinedPgn = pgnStrings.join("\n\n");
            
            const results = await this.pgnManager.ingestPgnString(combinedPgn);

            console.log(`[Chess.com] Ingestion complete: ${results.success} success, ${results.failed} failed.`);

            return res.json({ 
                status: "success", 
                ingested: results.success, 
                failed: results.failed,
                totalFetched: games.length
            });
        } catch (err: any) {
            console.error("[Chess.com] Error fetching games:", err);
            return res.status(500).json({ error: err.message });
        }
    }
}
