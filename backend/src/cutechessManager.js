import {spawn} from "bun";
import {EventEmitter} from "node:events";

// TODO: migrate to ts

// argv for `ssh <target> <remoteCommand>` (mirrors SshUciEngine's flags).
function sshArgs(target, remoteCommand) {
    const args = ["ssh"];
    if (target.keyPath) args.push("-i", target.keyPath);
    args.push("-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30");
    args.push(target.user ? `${target.user}@${target.host}` : target.host);
    args.push(remoteCommand);
    return args;
}

// Quote one argument for safe interpolation into a remote shell command.
function shellQuote(arg) {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, "'\\''")}'`;
}

export class CutechessManager extends EventEmitter {
    constructor(cutechessPath, sshTarget = null) {
        super();
        this.cmd = cutechessPath;
        this.sshTarget = sshTarget; // {host, user?, keyPath?} -> run cutechess ON the remote
        this.process = null;
    }

    _buildEngineArgs(engineInfo) {
        const args = ["-engine", `name=${engineInfo.name}`];
        if (this.sshTarget) {
            // cutechess runs on the remote host; engines are plain paths there.
            args.push(`cmd=${engineInfo.path}`);
        } else if (engineInfo.sshConfig) {
            args.push(`cmd=ssh`);
            if (engineInfo.sshConfig.keyPath) {
                args.push(`arg=-i`, `arg=${engineInfo.sshConfig.keyPath}`);
            }
            args.push(`arg=-o`, `arg=StrictHostKeyChecking=no`);
            args.push(`arg=-o`, `arg=ServerAliveInterval=30`);
            const target = engineInfo.sshConfig.user ? `${engineInfo.sshConfig.user}@${engineInfo.sshConfig.host}` : engineInfo.sshConfig.host;
            args.push(`arg=${target}`);
            args.push(`arg=${engineInfo.sshConfig.stockfishPath || engineInfo.path}`);
        } else {
            args.push(`cmd=${engineInfo.path}`);
        }
        if (engineInfo.args) args.push(...engineInfo.args);
        return args;
    }

    async runGauntlet({myEngine, opponents, timeControl = "10+0.1", depth = null, nodes = null, rounds = 50, concurrency = 4, pgnOut = "gauntlet.pgn", openingBook = null}) {
        if (this.process) throw new Error("A tournament is already running!");

        console.log(`[Cutechess] Starting Gauntlet: ${myEngine.name} vs ${opponents.length} opponents${this.sshTarget ? ` (remote: ${this.sshTarget.host})` : ""}.`);

        const args = [];
        args.push(...this._buildEngineArgs(myEngine));
        for (const opp of opponents) {
            args.push(...this._buildEngineArgs(opp));
        }

        const eachArgs = ["-each", `tc=${timeControl}`, `proto=uci`];
        if (depth) eachArgs.push(`depth=${depth}`);
        if (nodes) eachArgs.push(`nodes=${nodes}`);

        args.push(
            "-tournament", "gauntlet",
            ...eachArgs,
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

        // Local: run cutechess here. Remote: run it on the SSH host so neither the
        // engines nor the orchestrator execute on this box.
        const spawnCmd = this.sshTarget
            ? sshArgs(this.sshTarget, [this.cmd, ...args].map(shellQuote).join(" "))
            : [this.cmd, ...args];

        return new Promise((resolve, reject) => {
            try {
                this.process = spawn({
                    cmd: spawnCmd,
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
