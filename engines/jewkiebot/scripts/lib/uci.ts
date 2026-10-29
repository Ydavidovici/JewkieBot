// Minimal UCI driver for the engine test scripts (tactics, verification):
// start an engine process, send commands, wait for a reply line.

import {spawn} from "bun";

export class Uci {
    private proc;
    private lines: string[] = [];
    private waiters: {match: (line: string) => boolean; resolve: (line: string) => void}[] = [];

    constructor(path: string) {
        this.proc = spawn({cmd: [path], stdin: "pipe", stdout: "pipe", stderr: "ignore"});
        this.readLoop();
    }

    private async readLoop() {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of this.proc.stdout) {
            buffer += decoder.decode(chunk);
            let i;
            while ((i = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, i).trim();
                buffer = buffer.slice(i + 1);
                const w = this.waiters.findIndex(w => w.match(line));
                if (w >= 0) this.waiters.splice(w, 1)[0].resolve(line);
                else this.lines.push(line);
            }
        }
    }

    send(command: string) {
        this.proc.stdin.write(command + "\n");
        this.proc.stdin.flush();
    }

    // Send a command and resolve with the first output line that matches.
    request(command: string, match: (line: string) => boolean, timeoutMs = 60_000): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting after: ${command}`)), timeoutMs);
            this.waiters.push({match, resolve: (line) => { clearTimeout(timer); resolve(line); }});
            this.send(command);
        });
    }

    async init(options: Record<string, string | number> = {}) {
        await this.request("uci", l => l === "uciok");
        for (const [name, value] of Object.entries(options)) this.send(`setoption name ${name} value ${value}`);
        await this.request("isready", l => l === "readyok");
    }

    // Best move (UCI) for a position, searched for `movetime` ms or to `depth`.
    async bestMove(fen: string, limit: {movetime?: number; depth?: number}): Promise<string> {
        this.send("ucinewgame");
        await this.request("isready", l => l === "readyok");
        this.send(`position fen ${fen}`);
        const go = limit.depth ? `go depth ${limit.depth}` : `go movetime ${limit.movetime ?? 500}`;
        const line = await this.request(go, l => l.startsWith("bestmove"), (limit.movetime ?? 0) + 120_000);
        return line.split(/\s+/)[1];
    }

    async quit() {
        this.send("quit");
        await this.proc.exited;
    }
}
