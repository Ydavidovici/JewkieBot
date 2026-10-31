// The engine's eval-params file format (engines/jewkiebot/src/evaluator.cpp,
// Evaluator::paramsFileHeader): a header line naming the parameter layout,
// then one integer per line. The engine refuses a file whose header doesn't
// match its own layout, so a file tuned for an older layout can't load
// values into the wrong slots.
export const EVAL_PARAMS_LAYOUT = "jewkiebot-eval v2";

export function formatEvalParams(params: number[]): string {
    return `# ${EVAL_PARAMS_LAYOUT} ${params.length}\n` + params.map((n) => Math.round(n)).join("\n") + "\n";
}

// Values from a params file or a pasted vector; header/comment lines are skipped.
export function parseEvalParams(text: string): number[] {
    return text
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join(" ")
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
}
