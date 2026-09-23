import { Request, Response } from "express";
import path from "path";
import { dbClient } from "../dbClient.js";
import { PolyglotReader } from "../utils/polyglotReader.ts";

// Helper to fetch from Lichess Explorer API
async function fetchLichessExplorer(fen: string) {
    const url = `https://explorer.lichess.ovh/lichess?variant=standard&fen=${encodeURIComponent(fen)}`;

    try {
        const headers: any = { 
            "User-Agent": "JewkieBot Analysis Client (Personal Project)",
            "Accept": "application/json"
        };
        const token = process.env.LICHESS_TOKEN || process.env.lichess_api_token;
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const response = await fetch(url, { headers });
        if (response.status === 401 || response.status === 403) return { error: "auth_required" };
        if (!response.ok) return null;
        return await response.json();
    } catch (err) {
        return null;
    }
}

// Helper to fetch from Lichess Master API
async function fetchLichessMasters(fen: string) {
    const url = `https://explorer.lichess.ovh/masters?variant=standard&fen=${encodeURIComponent(fen)}`;

    try {
        const headers: any = { "User-Agent": "JewkieBot Analysis Client (Personal Project)", "Accept": "application/json" };
        const token = process.env.LICHESS_TOKEN || process.env.lichess_api_token;
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const response = await fetch(url, { headers });
        if (response.status === 401 || response.status === 403) return { error: "auth_required" };
        if (!response.ok) return null;
        return await response.json();
    } catch (err) {
        return null;
    }
}

export class ExplorerController {
    private polyglotReader: PolyglotReader;

    constructor() {
        const bookPath = path.resolve(import.meta.dir, "../../../engines/jewkiebot/book.bin");
        this.polyglotReader = new PolyglotReader(bookPath);
    }

    getExplorerData = async (req: Request, res: Response) => {
        const { fen } = req.query;

        if (!fen || typeof fen !== "string") {
            return res.status(400).json({ error: "FEN is required" });
        }

        try {
            const [lichessData, masterData, polyglotData] = await Promise.all([
                fetchLichessExplorer(fen),
                fetchLichessMasters(fen),
                this.polyglotReader.findMoves(fen).catch(() => null)
            ]);

            res.json({
                fen,
                lichess: lichessData,
                masters: masterData,
                book: polyglotData
            });
        } catch (error) {
            console.error("[Explorer] Error handling request:", error);
            res.status(500).json({ error: "Failed to fetch explorer data" });
        }
    }
}