import {describe, it, expect} from "bun:test";
import {TuningController} from "../../src/controllers/tuningController.ts";

// A quiet position (side to move not in check) and one where the side to move IS
// in check — used to exercise _buildEpd's in-check filter.
const FEN_QUIET = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const FEN_INCHECK = "rnbqkbnr/ppp2ppp/8/1B1pp3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 3";

// _buildEpd only touches dbClient.getGameMoves; the other deps are unused here.
function makeController(movesByGame: Record<string, any[]>): any {
    const dbClient = {
        getGameMoves: async (id: any) => movesByGame[String(id)] ?? [],
    };
    return new TuningController({}, dbClient, {}, "/tmp/eval_params.txt");
}

describe("TuningController._buildEpd", () => {
    it("skips games without a decisive/known result", async () => {
        const ctrl = makeController({"1": [{ply: 13, fen_after: FEN_QUIET}]});
        const r = await ctrl._buildEpd([{id: 1, result: "*"}]);
        expect(r.positions).toBe(0);
    });

    it("labels results and formats EPD lines", async () => {
        const ctrl = makeController({
            "1": [{ply: 13, fen_after: FEN_QUIET}],
            "2": [{ply: 13, fen_after: FEN_QUIET}],
            "3": [{ply: 13, fen_after: FEN_QUIET}],
        });
        const r = await ctrl._buildEpd([
            {id: 1, result: "1-0"},
            {id: 2, result: "0-1"},
            {id: 3, result: "1/2-1/2"},
        ]);
        expect(r.positions).toBe(3);
        expect(r.lines).toContain(`${FEN_QUIET} c9 "1.0"`);
        expect(r.lines).toContain(`${FEN_QUIET} c9 "0.0"`);
        expect(r.lines).toContain(`${FEN_QUIET} c9 "0.5"`);
    });

    it("skips the opening (ply <= 12)", async () => {
        const ctrl = makeController({"1": [
            {ply: 1, fen_after: FEN_QUIET},
            {ply: 12, fen_after: FEN_QUIET},
            {ply: 13, fen_after: FEN_QUIET},
        ]});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(1);
    });

    it("skips in-check positions", async () => {
        const ctrl = makeController({"1": [
            {ply: 13, fen_after: FEN_QUIET},
            {ply: 14, fen_after: FEN_INCHECK},
        ]});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(1);
        expect(r.lines[0]).toBe(`${FEN_QUIET} c9 "1.0"`);
    });

    it("accepts camelCase fenAfter and skips rows missing a FEN", async () => {
        const ctrl = makeController({"1": [
            {ply: 13, fenAfter: FEN_QUIET},
            {ply: 14},  // no FEN -> skipped
        ]});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(1);
    });

    it("skips games with no moves", async () => {
        const ctrl = makeController({"1": []});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(0);
    });
});
