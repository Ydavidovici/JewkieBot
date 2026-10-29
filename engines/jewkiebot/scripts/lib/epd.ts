// EPD parsing for the tactics scripts. A line is the first four FEN fields
// followed by `;`-separated operations, e.g.
//   r6k/8/8/8/8/8/3PPP2/4K2R b K - bm a8a1; id "castling-mate1"; c0 "note";
// `bm` (best moves) and `am` (avoid moves) may be UCI (e7e8q) or SAN (Qxf7+);
// both are returned as UCI.

import {Chess} from "../../../../backend/node_modules/chess.js";
import {readFileSync} from "node:fs";

export interface EpdPosition {
    fen: string;          // full FEN (move counters added)
    bm: string[];         // best moves, UCI
    am: string[];         // moves to avoid, UCI
    id: string;
    comment: string;
    line: string;         // the original EPD line
}

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function toUci(fen: string, move: string): string | null {
    if (UCI_MOVE.test(move)) return move;
    try {
        const m = new Chess(fen).move(move);
        return m.from + m.to + (m.promotion ?? "");
    } catch {
        return null;
    }
}

export function parseEpdLine(line: string): EpdPosition | null {
    const text = line.trim();
    if (!text || text.startsWith("#")) return null;

    const fields = text.split(/\s+/);
    if (fields.length < 5) return null;
    const fen = fields.slice(0, 4).join(" ") + " 0 1";
    const ops = fields.slice(4).join(" ");

    const pos: EpdPosition = {fen, bm: [], am: [], id: "", comment: "", line: text};
    for (const op of ops.split(";").map(s => s.trim()).filter(Boolean)) {
        const [name, ...args] = op.split(/\s+/);
        const value = args.join(" ").replace(/^"|"$/g, "");
        if (name === "bm" || name === "am") {
            for (const move of args) {
                const uci = toUci(fen, move.replace(/[!?]+$/, ""));
                if (uci) pos[name].push(uci);
            }
        } else if (name === "id") pos.id = value;
        else if (name === "c0") pos.comment = value;
    }
    return pos.bm.length || pos.am.length ? pos : null;
}

export function readEpd(path: string): EpdPosition[] {
    return readFileSync(path, "utf8").split(/\r?\n/).map(parseEpdLine).filter((p): p is EpdPosition => p !== null);
}
