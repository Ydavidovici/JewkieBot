import {EventEmitter} from "node:events";

export const LEVELS = Object.freeze({
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
    FATAL: "fatal",
});

const LEVEL_RANK = {info: 10, warn: 20, error: 30, fatal: 40};

export class Notifier extends EventEmitter {
    constructor({minLevel = LEVELS.INFO, transports = []} = {}) {
        super();
        this.minLevel = minLevel;
        this.transports = [];
        for (const t of transports) this.addTransport(t);
    }

    addTransport(transport) {
        if (!transport || typeof transport.send !== "function") {
            throw new Error("Transport must implement send(event)");
        }
        this.transports.push(transport);
    }

    setMinLevel(level) {
        if (!(level in LEVEL_RANK)) throw new Error(`Unknown level: ${level}`);
        this.minLevel = level;
    }

    info(subject, details)  { return this.notify(LEVELS.INFO,  subject, details); }
    warn(subject, details)  { return this.notify(LEVELS.WARN,  subject, details); }
    error(subject, details) { return this.notify(LEVELS.ERROR, subject, details); }
    fatal(subject, details) { return this.notify(LEVELS.FATAL, subject, details); }

    notify(level, subject, details) {
        if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return Promise.resolve();

        const event = {
            level,
            subject: String(subject ?? ""),
            details: details ?? null,
            timestamp: new Date().toISOString(),
        };

        this.emit("notify", event);

        // Send to all transports in parallel; never let one failure block the others.
        return Promise.allSettled(this.transports.map(t => {
            try {
                return Promise.resolve(t.send(event));
            } catch (err) {
                return Promise.reject(err);
            }
        })).then(results => {
            for (const r of results) {
                if (r.status === "rejected") {
                    console.error("[Notifier] Transport failed:", r.reason);
                }
            }
        });
    }

    // Best-effort flush: lets transports drain any buffered work before exit.
    async flush(timeoutMs = 3000) {
        const flushes = this.transports
            .filter(t => typeof t.flush === "function")
            .map(t => Promise.resolve(t.flush()).catch(err => {
                console.error("[Notifier] Flush failed:", err);
            }));

        const timeout = new Promise(r => setTimeout(r, timeoutMs));
        await Promise.race([Promise.all(flushes), timeout]);
    }
}

export class ConsoleTransport {
    constructor({stream = console, prefix = "[Notify]"} = {}) {
        this.stream = stream;
        this.prefix = prefix;
    }

    send(event) {
        const line = `${this.prefix} [${event.level.toUpperCase()}] ${event.subject}`;
        const fn = event.level === "error" || event.level === "fatal"
            ? this.stream.error.bind(this.stream)
            : event.level === "warn"
                ? this.stream.warn.bind(this.stream)
                : this.stream.log.bind(this.stream);

        if (event.details != null) fn(line, event.details);
        else fn(line);
    }
}

// Drop-in no-op notifier so callers don't have to null-check.
export const nullNotifier = new Notifier({transports: []});

// Prefixes from our own transports / notifier internals. If a console line
// starts with one of these, we don't re-forward it through the notifier or we
// get an infinite loop (transport logs → wrapped console → notifier → transport).
export const CONSOLE_WRAP_SKIP_PREFIXES = [
    "[ApiTransport]",
    "[Discord]",
    "[HealthPinger]",
    "[Notifier]",
    "[Notify]",
    "[sdNotify]",
];

function formatConsoleArg(a) {
    if (typeof a === "string") return a;
    if (a == null) return String(a);
    if (a instanceof Error) return a.stack ? a.stack.split("\n").slice(0, 4).join("\n") : `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); }
    catch { return String(a); }
}

// Tee every console.{log,info,warn,error} call through the notifier so all
// terminal output also flows to whatever transports are wired up (Discord, an
// API endpoint, etc.). Original console methods are still invoked so the
// terminal looks unchanged.
//
// Lines whose first arg starts with a known internal prefix
// (CONSOLE_WRAP_SKIP_PREFIXES) are printed but NOT forwarded, to avoid feedback
// loops when a transport itself logs.
//
// Returns a restore() function so tests (and `process.on("exit")`) can unhook.
export function wrapConsoleForNotifier(notifier, options = {}) {
    const skipPrefixes = options.skipPrefixes ?? CONSOLE_WRAP_SKIP_PREFIXES;

    // Captured by reference (not bound) so restore() puts back the *exact*
    // original function, not a bound wrapper.
    const orig = {
        log:   console.log,
        info:  console.info ?? console.log,
        warn:  console.warn,
        error: console.error,
    };

    const shouldSkip = (args) => {
        if (args.length === 0) return true;
        const first = formatConsoleArg(args[0]);
        return skipPrefixes.some(p => first.startsWith(p));
    };

    const formatLine = (args) => args.map(formatConsoleArg).join(" ");

    const wrap = (level, origFn) => (...args) => {
        origFn(...args);
        if (shouldSkip(args)) return;
        const line = formatLine(args);
        // Fire-and-forget; don't block the caller and don't let a transport
        // failure leak back up through console.*.
        try { notifier[level](line)?.catch?.(() => {}); }
        catch (_) {}
    };

    console.log   = wrap("info",  orig.log);
    console.info  = wrap("info",  orig.info);
    console.warn  = wrap("warn",  orig.warn);
    console.error = wrap("error", orig.error);

    return () => {
        console.log   = orig.log;
        console.info  = orig.info;
        console.warn  = orig.warn;
        console.error = orig.error;
    };
}

export class JournalTransport {
    constructor({stream = process.stdout} = {}) {
        this.stream = stream;
    }

    send(event) {
        // Syslog severities: 3=err, 4=warning, 6=info
        let severity = 6;
        if (event.level === "fatal" || event.level === "error") severity = 3;
        else if (event.level === "warn") severity = 4;

        let msg = `<${severity}>${event.subject}`;
        if (event.details != null) {
            try {
                msg += " " + (typeof event.details === "object" ? JSON.stringify(event.details) : String(event.details));
            } catch (e) {
                msg += " [Error stringifying details]";
            }
        }

        this.stream.write(msg + "\n");
    }
}

export function sdNotify(state) {
    const socketPath = process.env.NOTIFY_SOCKET;
    if (!socketPath) return;

    import("node:dgram").then(dgram => {
        const client = dgram.createSocket("unix_dgram");
        const msg = Buffer.from(state);
        client.send(msg, 0, msg.length, socketPath, (err) => {
            if (err) console.error("[sdNotify] failed:", err);
            client.close();
        });
    }).catch(err => console.error("[sdNotify] dgram import failed:", err));
}
