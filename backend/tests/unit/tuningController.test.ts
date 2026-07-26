import {describe, it, expect} from "bun:test";
import {TuningController} from "../../src/controllers/tuningController.ts";

// A quiet position (side to move not in check) and one where the side to move IS
// in check — used to exercise _buildEpd's in-check filter.
const FEN_QUIET = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const FEN_INCHECK = "rnbqkbnr/ppp2ppp/8/1B1pp3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 3";

// _buildEpd only touches dbClient.getGameMoves; the other deps are unused here.
// `movesResponse` lets a test return whatever shape the DB layer would (an array,
// or a Laravel-style {data:[...]} wrapper).
function makeController(movesByGame: Record<string, any>): any {
    const dbClient = {
        getGameMoves: async (id: any) => movesByGame[String(id)] ?? [],
    };
    return new TuningController({}, dbClient, {}, "/tmp/eval_params.txt");
}

describe("TuningController.resultLabel", () => {
    it("maps decisive/draw results in every stored form", () => {
        const label = (TuningController as any).resultLabel;
        expect(label("1-0")).toBe("1.0");
        expect(label("0-1")).toBe("0.0");
        expect(label("1/2-1/2")).toBe("0.5");
        expect(label("1.0")).toBe("1.0");
        expect(label("0.5")).toBe("0.5");
    });
    it("returns null for unfinished / unknown results", () => {
        const label = (TuningController as any).resultLabel;
        expect(label("*")).toBeNull();
        expect(label(null)).toBeNull();
        expect(label(undefined)).toBeNull();
    });
});

describe("TuningController.asArray", () => {
    it("passes arrays through and unwraps {data} / {moves} wrappers", () => {
        const asArray = (TuningController as any).asArray;
        expect(asArray([1, 2])).toEqual([1, 2]);
        expect(asArray({data: [1, 2]})).toEqual([1, 2]);
        expect(asArray({moves: [3]})).toEqual([3]);
        expect(asArray(null)).toEqual([]);
        expect(asArray({})).toEqual([]);
    });
});

describe("TuningController._buildEpd", () => {
    it("skips games without a decisive/known result", async () => {
        const ctrl = makeController({"1": [{ply: 13, fen_after: FEN_QUIET}]});
        const r = await ctrl._buildEpd([{id: 1, result: "*"}]);
        expect(r.positions).toBe(0);
        expect(r.stats).toEqual({games: 1, decisive: 0, withMoves: 0, candidates: 0});
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
        expect(r.stats).toEqual({games: 3, decisive: 3, withMoves: 3, candidates: 3});
    });

    it("skips the opening (ply <= 12), with numeric or string ply", async () => {
        const ctrl = makeController({"1": [
            {ply: 1, fen_after: FEN_QUIET},
            {ply: 12, fen_after: FEN_QUIET},
            {ply: "12", fen_after: FEN_QUIET},   // string form still filtered
            {ply: 13, fen_after: FEN_QUIET},
            {ply: "14", fen_after: FEN_QUIET},   // string form still kept
        ]});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(2);
        expect(r.stats.candidates).toBe(2);
    });

    it("skips in-check positions but keeps them counted as candidates", async () => {
        const ctrl = makeController({"1": [
            {ply: 13, fen_after: FEN_QUIET},
            {ply: 14, fen_after: FEN_INCHECK},
        ]});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(1);
        expect(r.lines[0]).toBe(`${FEN_QUIET} c9 "1.0"`);
        expect(r.stats.candidates).toBe(2);  // both passed opening/FEN checks
    });

    it("accepts camelCase fenAfter and skips rows missing a FEN", async () => {
        const ctrl = makeController({"1": [
            {ply: 13, fenAfter: FEN_QUIET},
            {ply: 14},  // no FEN -> not a candidate
        ]});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(1);
        expect(r.stats.candidates).toBe(1);
    });

    // This is the regression for the observed "Dataset is empty" failure: the DB
    // layer returned moves wrapped as {data:[...]}, so a plain Array.isArray check
    // dropped every game. asArray() must unwrap it.
    it("handles a {data:[...]} wrapped moves response (Laravel resource collection)", async () => {
        const ctrl = makeController({"1": {data: [
            {ply: 13, fen_after: FEN_QUIET},
            {ply: 14, fen_after: FEN_QUIET},
        ]}});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}]);
        expect(r.positions).toBe(2);
        expect(r.stats.withMoves).toBe(1);
    });

    it("reports a breakdown when games have no ingested moves", async () => {
        const ctrl = makeController({"1": [], "2": []});
        const r = await ctrl._buildEpd([{id: 1, result: "1-0"}, {id: 2, result: "0-1"}]);
        expect(r.positions).toBe(0);
        expect(r.stats).toEqual({games: 2, decisive: 2, withMoves: 0, candidates: 0});
    });
});
