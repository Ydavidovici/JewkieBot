import { describe, it, expect } from "bun:test";
import { PolyglotReader } from "../src/utils/polyglotReader.ts";

describe("PolyglotReader", () => {
    // We pass a dummy path because we are only testing the pure math functions
    const reader = new PolyglotReader("dummy.bin");

    it("should calculate the correct Zobrist hash for the starting position", () => {
        const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        
        // @ts-ignore - We are intentionally testing a private method
        const hash = reader.calculateZobristHash(startFen);
        
        // The universally standard Polyglot hash for the starting position
        expect(hash).toBe(0x463B96181691FC9Cn);
    });

    it("should calculate a different hash after a move", () => {
        const e4Fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
        
        // @ts-ignore
        const hash = reader.calculateZobristHash(e4Fen);
        
        // Standard Polyglot hash for 1. e4
        expect(hash).toBe(0x823C9B50FD114196n);
    });

    it("should parse bitwise moves into UCI strings correctly", () => {
        // e2e4 calculation:
        // toFile(e=4) | (toRow(4=3) << 3) | (fromFile(e=4) << 6) | (fromRow(2=1) << 9)
        // 4 | 24 | 256 | 512 = 796
        
        // @ts-ignore
        const move1 = reader.parseMove(796);
        expect(move1).toBe("e2e4");

        // g1f3 calculation:
        // toFile(f=5) | (toRow(3=2) << 3) | (fromFile(g=6) << 6) | (fromRow(1=0) << 9)
        // 5 | 16 | 384 | 0 = 405
        
        // @ts-ignore
        const move2 = reader.parseMove(405);
        expect(move2).toBe("g1f3");
    });
});
