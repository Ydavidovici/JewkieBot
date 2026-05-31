// Posts notifier events to an external notify service (the one that owns
// consumers.json + the Discord bot). The receiver looks the bearer token up in
// its consumers map and routes to the right channel based on `channel` and
// `status` fields in the payload.
//
// Env vars (read at construction time, can be overridden via options):
//   API_NOTIFY_URL   — full URL of the notify endpoint
//   API_NOTIFY_TOKEN — bearer token for the consumer entry (prod vs dev)
//   API_NOTIFY_PROJECT — optional project label included in the payload
//
// If url or token is missing the transport stays silent — letting callers
// register it unconditionally without crashing in environments that don't have
// a notify service configured.

const SUBJECT_TO_NOTIFICATIONS_CHANNEL = [
    "autoplay restart",
    "autoplay enabled",
    "rate limit",
    "rate-limited",
];

export class ApiTransport {
    constructor({url, token, project} = {}) {
        this.url = url ?? process.env.API_NOTIFY_URL ?? null;
        this.token = token ?? process.env.API_NOTIFY_TOKEN ?? null;
        this.project = project ?? process.env.API_NOTIFY_PROJECT ?? "";
        this.enabled = Boolean(this.url && this.token);
    }

    async send(event) {
        if (!this.enabled) return;

        const subjectLower = (event.subject ?? "").toLowerCase();
        const channel = SUBJECT_TO_NOTIFICATIONS_CHANNEL.some(s => subjectLower.includes(s))
            ? "notifications"
            : "logs";

        let status;
        if (event.level === "error" || event.level === "fatal") status = "error";
        else if (channel === "notifications")                   status = "success";

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
            const res = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.token}`,
                },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                // Log to console.error directly. The "[ApiTransport]" prefix is
                // on the wrapConsoleForNotifier skip list, so this won't loop.
                const text = await res.text().catch(() => "");
                console.error(`[ApiTransport] HTTP ${res.status}: ${text.slice(0, 300)}`);
            }
        } catch (err) {
            console.error("[ApiTransport] Request failed:", err?.message ?? err);
        }
    }
}
