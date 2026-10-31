import {describe, it, expect} from "bun:test";
import {existsSync} from "node:fs";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {formatEvalParams, parseEvalParams, EVAL_PARAMS_LAYOUT} from "../../src/evalParams.ts";

describe("evalParams file format", () => {
    it("writes the engine's header, then one rounded integer per line", () => {
        expect(formatEvalParams([1, -2.4, 3.6])).toBe(`# ${EVAL_PARAMS_LAYOUT} 3\n1\n-2\n4\n`);
    });

    it("reads values back, skipping the header", () => {
        expect(parseEvalParams(formatEvalParams([5, -7, 0]))).toEqual([5, -7, 0]);
    });

    it("accepts a pasted whitespace-separated vector without a header", () => {
        expect(parseEvalParams("1 2\n3\t4  ")).toEqual([1, 2, 3, 4]);
    });

    // The header must be exactly what the engine expects, or it refuses the
    // file. Checked against the real engine binary when one has been built.
    const engine = path.resolve(import.meta.dir, "../../../engines/jewkiebot/build",
        process.platform === "win32" ? "jewkiebot.exe" : "jewkiebot");
    it.skipIf(!existsSync(engine))("produces a file the engine loads", async () => {
        const proc = Bun.spawn([engine], {stdin: "pipe", stdout: "pipe"});
        proc.stdin.write("evalparams\nquit\n");
        proc.stdin.end();
        const out = await new Response(proc.stdout).text();
        const values = [...out.matchAll(/^evalparam \d+ (-?\d+)$/gm)].map((m) => Number(m[1]));
        expect(values.length).toBeGreaterThan(0);

        const dir = await mkdtemp(path.join(tmpdir(), "evalparams-"));
        const file = path.join(dir, "eval_params.txt");
        await writeFile(file, formatEvalParams(values));

        const load = Bun.spawn([engine], {stdin: "pipe", stdout: "pipe"});
        load.stdin.write(`setoption name EvalParamsFile value ${file}\nquit\n`);
        load.stdin.end();
        const reply = await new Response(load.stdout).text();
        expect(reply).toContain(`eval params loaded (${values.length} params)`);
    });
});
