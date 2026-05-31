import {spawn} from "bun";
import {EventEmitter} from "node:events";

export class CutechessManager extends EventEmitter {
    constructor(cutechessPath) {
        super();
        this.cmd = cutechessPath;
        this.process = null;
    }

    async runGauntlet({myEngine, opponents, timeControl = "10+0.1", rounds = 50, concurrency = 4, pgnOut = "gauntlet.pgn", openingBook = null}) {
        if (this.process) throw new Error("A tournament is already running!");

        console.log(`[Cutechess] Starting Gauntlet: ${myEngine.name} vs ${opponents.length} opponents.`);

        const args = ["-engine", `name=${myEngine.name}`, `cmd=${myEngine.path}`];
        for (const opp of opponents) {
            args.push("-engine", `name=${opp.name}`, `cmd=${opp.path}`);
            if (opp.args) args.push(...opp.args);
        }

        args.push(
            "-each", `tc=${timeControl}`,
            "-rounds", rounds.toString(),
            "-games", "2",
            "-repeat",
            "-concurrency", concurrency.toString(),
            "-ratinginterval", "10",
            "-pgnout", pgnOut,
        );

        if (openingBook) {
            args.push("-openings", `file=${openingBook.file}`, `format=${openingBook.format}`, "order=random", "plies=16");
        }

        return new Promise((resolve, reject) => {
            try {
                this.process = spawn({
                    cmd: [this.cmd, ...args],
                    stdout: "pipe",
                    stderr: "pipe",
                });

                const decoder = new TextDecoder();

                (async () => {
                    for await (const chunk of this.process.stdout) {
                        const text = decoder.decode(chunk);
                        process.stdout.write(text);
                        if (text.includes("Elo difference:")) this.emit("elo_update", text);
                    }
                })();

                (async () => {
                    for await (const chunk of this.process.stderr) {
                        console.error(`[Cutechess Error] ${decoder.decode(chunk)}`);
                    }
                })();

                this.process.exited.then((code) => {
                    console.log(`[Cutechess] Tournament finished with exit code ${code}.`);
                    this.process = null;
                    if (code === 0) resolve(pgnOut);
                    else reject(new Error(`Cutechess exited with code ${code}`));
                });

            } catch (err) {
                console.error("[Cutechess] Failed to spawn:", err);
                reject(err);
            }
        });
    }

    stop() {
        if (this.process) {
            console.log("[Cutechess] Aborting tournament...");
            this.process.kill();
            this.process = null;
        }
    }
}
