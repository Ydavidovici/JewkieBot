import { Chess } from "chess.js";
import { open } from "fs/promises";
import { Random64 } from "./polyglotConstants.ts";

export class PolyglotReader {
    private bookPath: string;

    constructor(bookPath: string) {
        this.bookPath = bookPath;
    }

    private calculateZobristHash(fen: string): bigint {
        const game = new Chess(fen);
        let hash = 0n;
        const files = "abcdefgh";

        const pieceTypes: Record<string, number> = {
            'bp': 0, 'wp': 1, 'bn': 2, 'wn': 3,
            'bb': 4, 'wb': 5, 'br': 6, 'wr': 7,
            'bq': 8, 'wq': 9, 'bk': 10, 'wk': 11
        };

        // 1. Pieces
        for (let file = 0; file < 8; file++) {
            for (let rank = 1; rank <= 8; rank++) {
                const piece = game.get((files[file] + rank) as any);
                if (piece) {
                    const offset = 64 * pieceTypes[piece.color + piece.type] + 8 * (rank - 1) + file;
                    hash ^= Random64[offset];
                }
            }
        }

        // 2. Castling
        const castlingField = fen.split(' ')[2];
        if (castlingField.includes('K')) hash ^= Random64[768 + 0];
        if (castlingField.includes('Q')) hash ^= Random64[768 + 1];
        if (castlingField.includes('k')) hash ^= Random64[768 + 2];
        if (castlingField.includes('q')) hash ^= Random64[768 + 3];

        // 3. En Passant
        const fenEpSquare = fen.split(' ')[3];
        if (fenEpSquare !== '-') {
            const isWhite = game.turn() === 'w';
            const epRank = isWhite ? '5' : '4';
            const epFile = fenEpSquare[0];
            const expectedEpSquare = epFile + epRank;
            
            const epSquareIndex = files.indexOf(epFile);
            let hasPawn = false;
            
            if (epSquareIndex > 0) {
                const leftPiece = game.get((files[epSquareIndex - 1] + expectedEpSquare[1]) as any);
                if (leftPiece && leftPiece.type === 'p' && leftPiece.color === game.turn()) {
                    hasPawn = true;
                }
            }
            if (epSquareIndex < 7) {
                const rightPiece = game.get((files[epSquareIndex + 1] + expectedEpSquare[1]) as any);
                if (rightPiece && rightPiece.type === 'p' && rightPiece.color === game.turn()) {
                    hasPawn = true;
                }
            }
            if (hasPawn) {
                hash ^= Random64[772 + epSquareIndex];
            }
        }

        // 4. Turn
        if (game.turn() === 'w') {
            hash ^= Random64[780];
        }

        return hash;
    }

    private parseMove(move: number): string {
        const toFile = move & 7;
        const toRow = (move >> 3) & 7;
        const fromFile = (move >> 6) & 7;
        const fromRow = (move >> 9) & 7;
        const promObj = (move >> 12) & 7;
        
        let prom = "";
        if (promObj === 1) prom = "n";
        else if (promObj === 2) prom = "b";
        else if (promObj === 3) prom = "r";
        else if (promObj === 4) prom = "q";
        
        const files = "abcdefgh";
        return files[fromFile] + (fromRow + 1) + files[toFile] + (toRow + 1) + prom;
    }

    public async findMoves(fen: string): Promise<Array<{uci: string, weight: number}>> {
        const hash = this.calculateZobristHash(fen);
        const moves: Array<{uci: string, weight: number}> = [];

        try {
            const file = await open(this.bookPath, 'r');
            const stat = await file.stat();
            const entrySize = 16;
            const numEntries = Math.floor(stat.size / entrySize);

            let low = 0;
            let high = numEntries - 1;
            let firstMatch = -1;

            const buffer = Buffer.alloc(16);

            // Binary search
            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                await file.read(buffer, 0, 16, mid * entrySize);
                const entryHash = buffer.readBigUInt64BE(0);

                if (entryHash === hash) {
                    firstMatch = mid;
                    break;
                } else if (entryHash < hash) {
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }

            // Expand match left and right
            if (firstMatch !== -1) {
                // Scan left
                let current = firstMatch;
                while (current >= 0) {
                    await file.read(buffer, 0, 16, current * entrySize);
                    if (buffer.readBigUInt64BE(0) !== hash) break;
                    
                    const moveInt = buffer.readUInt16BE(8);
                    const weight = buffer.readUInt16BE(10);
                    moves.push({ uci: this.parseMove(moveInt), weight });
                    current--;
                }
                
                // Scan right
                current = firstMatch + 1;
                while (current < numEntries) {
                    await file.read(buffer, 0, 16, current * entrySize);
                    if (buffer.readBigUInt64BE(0) !== hash) break;
                    
                    const moveInt = buffer.readUInt16BE(8);
                    const weight = buffer.readUInt16BE(10);
                    moves.push({ uci: this.parseMove(moveInt), weight });
                    current++;
                }
            }
            
            await file.close();
            
            // Sort by highest weight first
            moves.sort((a, b) => b.weight - a.weight);
            
            return moves;
        } catch (err) {
            console.error("Polyglot Read Error:", err);
            return [];
        }
    }
}
