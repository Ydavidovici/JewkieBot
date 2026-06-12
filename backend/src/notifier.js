import {EventEmitter} from "node:events";
import {ApiTransport} from "./apiTransport.js";

export const LEVELS = Object.freeze({
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
    FATAL: "fatal",
});

const LEVEL_RANK = {info: 10, warn: 20, error: 30, fatal: 40};

export class WebhookTransport {
    constructor({url, token, project} = {}) {
        this.api = new ApiTransport({ baseUrl: url || process.env.API_NOTIFY_URL, token: token || process.env.API_NOTIFY_TOKEN });
        this.project = project || process.env.API_NOTIFY_PROJECT || "";
        this.enabled = Boolean(this.api.baseUrl && this.api.token);
    }

    async send(event) {
        if (!this.enabled) return;

        const channel = "notifications";

        let status;
        if (event.level === "error" || event.level === "fatal") status = "error";
        else status = "success";

        const levelStr = String(event.level ?? "info").toUpperCase();
        let bodyText = `[ ${levelStr} ] ${event.subject}`;
        if (event.details != null && (typeof event.details !== "object" || Object.keys(event.details).length > 0)) {
            try {
                bodyText += "\n" + (typeof event.details === "object"
                    ? JSON.stringify(event.details, null, 2)
                    : String(event.details));
            } catch (_) {
                bodyText += "\n[unserializable details]";
            }
        }
        const message = "```\n" + bodyText + "\n```";

        const payload = {message, channel, project: this.project};
        if (status) payload.status = status;

        try {
            await this.api.post("", payload);
        } catch (err) {
            // Error logging is handled by ApiTransport already, but to prevent recursion,
            // we ensure the error string includes "[ApiTransport]" to be caught by the skip list.
            console.error("[ApiTransport] Webhook request failed:", err?.message ?? err);
        }
    }
}

export class Notifier extends EventEmitter {
    constructor({minLevel = LEVELS.INFO, transports = [new WebhookTransport()]} = {}) {
        super();
        this.minLevel = minLevel;
        this.transports = [];
        for (const t of transports) {
            this.addTransport(t);
        }
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

    info(subject, details) {
        return this.notify(LEVELS.INFO, subject, details);
    }

    warn(subject, details) {
        return this.notify(LEVELS.WARN, subject, details);
    }

    error(subject, details) {
        return this.notify(LEVELS.ERROR, subject, details);
    }

    fatal(subject, details) {
        return this.notify(LEVELS.FATAL, subject, details);
    }

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

// Drop-in no-op notifier so callers don't have to null-check.
export const nullNotifier = new Notifier({transports: []});

export const CONSOLE_WRAP_SKIP_PREFIXES = ["[ApiTransport]", "[Notifier]"];

export function wrapConsoleForNotifier(notifier) {
    const origConsole = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
    };

    function shouldSkip(args) {
        if (args.length === 0) return false;
        const first = String(args[0]);
        return CONSOLE_WRAP_SKIP_PREFIXES.some(prefix => first.includes(prefix));
    }

    function formatArgs(args) {
        return args.map(a => {
            if (a instanceof Error) return a.stack || String(a);
            if (typeof a === "object") {
                try {
                    return JSON.stringify(a);
                } catch {
                    return String(a);
                }
            }
            return String(a);
        }).join(" ");
    }

    console.log = function(...args) {
        origConsole.log.apply(console, args);
        if (!shouldSkip(args)) notifier.info(formatArgs(args));
    };

    console.info = function(...args) {
        origConsole.info.apply(console, args);
        if (!shouldSkip(args)) notifier.info(formatArgs(args));
    };

    console.warn = function(...args) {
        origConsole.warn.apply(console, args);
        if (!shouldSkip(args)) notifier.warn(formatArgs(args));
    };

    console.error = function(...args) {
        origConsole.error.apply(console, args);
        if (!shouldSkip(args)) notifier.error(formatArgs(args));
    };

    return function restore() {
        console.log = origConsole.log;
        console.info = origConsole.info;
        console.warn = origConsole.warn;
        console.error = origConsole.error;
    };
}