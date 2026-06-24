import {ApiTransport} from "./apiTransport.js";
import {Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, EmbedBuilder} from "discord.js";

const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const DEFAULT_HEALTH_INTERVAL_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

const LEVEL_EMOJI: Record<string, string> = {info: ":information_source:", warn: ":warning:", error: ":x:", fatal: ":rotating_light:"};

type SendFn = (channelId: string, content: any) => Promise<void>;

interface LogEvent {
    level: string;
    subject: any;
    details?: any;
    timestamp?: string | number | Date;
}

interface DiscordTransportOptions {
    channelId: string;
    sendFn: SendFn;
    flushIntervalMs?: number;
}

interface HealthPingerOptions {
    url: string;
    sendFn?: SendFn;
    channelId?: string;
    intervalMs?: number;
    timeoutMs?: number;
    label?: string;
}

interface CreateDiscordBotOptions {
    token: string;
    channelId: string;
    notifier?: any;
    healthUrl?: string;
    apiUrl?: string;
    intents?: any;
}

export class DiscordTransport {
    channelId: string;
    sendFn: SendFn;
    flushIntervalMs: number;
    buffer: LogEvent[];
    timer: any;

    constructor({channelId, sendFn, flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS}: DiscordTransportOptions) {
        if (!channelId) throw new Error("DiscordTransport requires channelId");
        if (typeof sendFn !== "function") throw new Error("DiscordTransport requires sendFn(channelId, content)");
        this.channelId = channelId;
        this.sendFn = sendFn;
        this.flushIntervalMs = flushIntervalMs;
        this.buffer = [];
        this.timer = null;
    }

    send(event: LogEvent) {
        this.buffer.push(event);
        this._scheduleFlush();
    }

    _scheduleFlush() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(err => console.error("[Discord] Flush error:", err));
        }, this.flushIntervalMs);
    }

    async flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.buffer.length === 0) return;

        const drained = this.buffer.splice(0);
        const embedChunks: any[] = [];
        let currentChunk: any[] = [];

        for (const event of drained) {
            const embed = new EmbedBuilder()
                .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());

            if (event.level === "error" || event.level === "fatal") embed.setColor(0xFF0000);
            else if (event.level === "warn") embed.setColor(0xFFA500);
            else embed.setColor(0x00FF00);

            embed.setTitle(`${LEVEL_EMOJI[event.level] ?? ""} ${event.level.toUpperCase()}`);

            let desc = `**${String(event.subject).slice(0, 250)}**`;

            if (event.details != null && (typeof event.details !== "object" || Object.keys(event.details).length > 0)) {
                const detailsStr = safeJson(event.details).slice(0, 3500);
                desc += `\n\`\`\`json\n${detailsStr}\n\`\`\``;
            }
            embed.setDescription(desc);

            currentChunk.push(embed);
            if (currentChunk.length === 10) {
                embedChunks.push(currentChunk);
                currentChunk = [];
            }
        }

        if (currentChunk.length > 0) embedChunks.push(currentChunk);

        for (const embeds of embedChunks) {
            try {
                await this.sendFn(this.channelId, {embeds});
            } catch (err) {
                console.error("[Discord] Send failed:", err);
            }
        }
    }
}

export class HealthPinger {
    api: ApiTransport;
    sendFn?: SendFn;
    channelId?: string;
    intervalMs: number;
    timeoutMs: number;
    label: string;
    lastStatus: boolean | null;
    timer: any;
    consecutiveFailures: number;

    constructor({url, sendFn, channelId, intervalMs = DEFAULT_HEALTH_INTERVAL_MS, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, label = "backend"}: HealthPingerOptions) {
        if (!url) throw new Error("HealthPinger requires url");
        this.api = new ApiTransport({baseUrl: url});
        this.sendFn = sendFn;
        this.channelId = channelId;
        this.intervalMs = intervalMs;
        this.timeoutMs = timeoutMs;
        this.label = label;
        this.lastStatus = null; // null=unknown, true=up, false=down
        this.timer = null;
        this.consecutiveFailures = 0;
    }

    start() {
        if (this.timer) return;
        this._tick();
        this.timer = setInterval(() => this._tick(), this.intervalMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async _tick() {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), this.timeoutMs);

        let up = false;
        let detail: string | null = null;
        try {
            await this.api.get("", {signal: ac.signal, silent: true});
            up = true;
            detail = null;
        } catch (err: any) {
            up = false;
            detail = err?.name === "AbortError" ? "timeout" : (err?.message || "request failed");
        } finally {
            clearTimeout(to);
        }

        const previousFailures = this.consecutiveFailures;
        if (up) this.consecutiveFailures = 0;
        else this.consecutiveFailures++;

        if (this.lastStatus === null) {
            await this._announce(up ? `:white_check_mark: ${this.label} is UP` : `:x: ${this.label} is DOWN (${detail})`);
        } else if (up && this.lastStatus === false) {
            await this._announce(`:white_check_mark: ${this.label} recovered (was down ${previousFailures} previous checks)`);
        } else if (!up && this.lastStatus === true) {
            await this._announce(`:x: ${this.label} went DOWN (${detail})`);
        }

        this.lastStatus = up;
    }

    async _announce(line: string) {
        if (!this.sendFn || !this.channelId) return;
        try { await this.sendFn(this.channelId, line); }
        catch (err) { console.error("[HealthPinger] Send failed:", err); }
    }
}

export async function createDiscordBot({token, channelId, notifier, healthUrl, apiUrl, intents = null}: CreateDiscordBotOptions) {
    if (!token) throw new Error("createDiscordBot requires token");
    if (!channelId) throw new Error("createDiscordBot requires channelId");

    const client = new Client({
        intents: intents ?? [GatewayIntentBits.Guilds],
    });

    const sendFn: SendFn = async (chId, content) => {
        const channel: any = await client.channels.fetch(chId);
        if (!channel || !channel.isTextBased()) {
            throw new Error(`Channel ${chId} is not text-based`);
        }
        await channel.send(content);
    };

    const transport = new DiscordTransport({channelId, sendFn});

    const pinger = healthUrl
        ? new HealthPinger({url: healthUrl, sendFn, channelId})
        : null;

    const api = apiUrl ? new ApiTransport({baseUrl: apiUrl}) : null;

    const commands = [
        new SlashCommandBuilder().setName("status").setDescription("Show bot status"),
        new SlashCommandBuilder().setName("health").setDescription("Ping the health endpoint now"),
        new SlashCommandBuilder()
            .setName("analysis")
            .setDescription("Run engine analysis on a FEN")
            .addStringOption(opt => opt.setName("fen").setDescription("The FEN string").setRequired(true))
            .addIntegerOption(opt => opt.setName("depth").setDescription("Search depth").setRequired(false)),
        new SlashCommandBuilder()
            .setName("bench")
            .setDescription("Run a quick engine benchmark")
            .addStringOption(opt => opt.setName("mode").setDescription("depth or time").setRequired(false))
            .addIntegerOption(opt => opt.setName("depth").setDescription("Search depth").setRequired(false)),
        new SlashCommandBuilder()
            .setName("lichess")
            .setDescription("Manage the Lichess bot")
            .addSubcommand(sub => sub.setName("start").setDescription("Start the Lichess bot"))
            .addSubcommand(sub => sub.setName("stop").setDescription("Stop the Lichess bot"))
            .addSubcommand(sub => sub.setName("status").setDescription("Check Lichess bot status"))
            .addSubcommandGroup(g => g
                .setName("autoplay")
                .setDescription("Control continuous autoplay")
                .addSubcommand(sub => sub
                    .setName("start")
                    .setDescription("Start autoplay with configurable params")
                    .addIntegerOption(o => o.setName("limit").setDescription("Initial clock, seconds (default 180)"))
                    .addIntegerOption(o => o.setName("increment").setDescription("Increment, seconds (default 2)"))
                    .addBooleanOption(o => o.setName("rated").setDescription("Rated games (default true)"))
                    .addIntegerOption(o => o.setName("target").setDescription("Concurrent games target (default 1)"))
                    .addStringOption(o => o.setName("mode").setDescription("Opponent selection mode (default near)"))
                    .addIntegerOption(o => o.setName("window").setDescription("Rating window (default 200)"))
                    .addStringOption(o => o.setName("white_opening_id").setDescription("Forced opening as White"))
                    .addStringOption(o => o.setName("black_opening_id").setDescription("Forced opening as Black")))
                .addSubcommand(sub => sub.setName("stop").setDescription("Stop autoplay"))
                .addSubcommand(sub => sub.setName("status").setDescription("Autoplay status")))
            .addSubcommandGroup(g => g
                .setName("challenge")
                .setDescription("Issue challenges")
                .addSubcommand(sub => sub
                    .setName("open")
                    .setDescription("Create an open challenge")
                    .addIntegerOption(o => o.setName("limit").setDescription("Clock, seconds (default 180)"))
                    .addIntegerOption(o => o.setName("increment").setDescription("Increment, seconds (default 0)"))
                    .addBooleanOption(o => o.setName("rated").setDescription("Rated (default true)")))
                .addSubcommand(sub => sub
                    .setName("ai")
                    .setDescription("Challenge the Lichess AI")
                    .addIntegerOption(o => o.setName("level").setDescription("AI level 1-8 (default 1)"))
                    .addIntegerOption(o => o.setName("limit").setDescription("Clock, seconds (default 180)"))
                    .addIntegerOption(o => o.setName("increment").setDescription("Increment, seconds (default 0)")))
                .addSubcommand(sub => sub
                    .setName("weakest")
                    .setDescription("Hunt the weakest online bot")
                    .addIntegerOption(o => o.setName("limit").setDescription("Clock, seconds (default 180)"))
                    .addIntegerOption(o => o.setName("increment").setDescription("Increment, seconds (default 0)"))
                    .addBooleanOption(o => o.setName("rated").setDescription("Rated (default true)")))),
        new SlashCommandBuilder()
            .setName("teacher")
            .setDescription("Run teacher (bulk game) analysis")
            .addSubcommand(sub => sub
                .setName("run")
                .setDescription("Analyze unanalyzed games")
                .addStringOption(o => o.setName("player").setDescription("Limit to a player name (optional)")))
            .addSubcommand(sub => sub.setName("stop").setDescription("Stop the running analysis"))
            .addSubcommand(sub => sub.setName("status").setDescription("Analysis progress"))
            .addSubcommand(sub => sub.setName("stats").setDescription("Analysis statistics")),
        new SlashCommandBuilder()
            .setName("cutechess")
            .setDescription("Run engine tournaments")
            .addSubcommand(sub => sub
                .setName("gauntlet")
                .setDescription("Run a gauntlet tournament")
                .addStringOption(o => o.setName("preset").setDescription("Opponent/engine preset"))
                .addStringOption(o => o.setName("tc").setDescription("Time control, e.g. 10+0.1"))
                .addIntegerOption(o => o.setName("games").setDescription("Games per pairing"))
                .addIntegerOption(o => o.setName("concurrency").setDescription("Concurrent games")))
            .addSubcommand(sub => sub
                .setName("selfplay")
                .setDescription("Run a self-play match")
                .addStringOption(o => o.setName("v1").setDescription("Engine version 1"))
                .addStringOption(o => o.setName("v2").setDescription("Engine version 2"))
                .addStringOption(o => o.setName("tc").setDescription("Time control, e.g. 10+0.1"))
                .addIntegerOption(o => o.setName("games").setDescription("Number of games"))
                .addIntegerOption(o => o.setName("depth").setDescription("Fixed depth (optional)"))
                .addIntegerOption(o => o.setName("nodes").setDescription("Fixed nodes (optional)"))),
        new SlashCommandBuilder()
            .setName("pgn")
            .setDescription("Ingest PGN data")
            .addSubcommand(sub => sub
                .setName("ingest")
                .setDescription("Ingest a PGN string")
                .addStringOption(o => o.setName("pgn").setDescription("The PGN text").setRequired(true))),
        new SlashCommandBuilder()
            .setName("chesscom")
            .setDescription("Fetch Chess.com games into the database")
            .addStringOption(o => o.setName("username").setDescription("Chess.com username").setRequired(true))
            .addIntegerOption(o => o.setName("months").setDescription("How many months back (default 1)")),
        new SlashCommandBuilder()
            .setName("tasks")
            .setDescription("Inspect background tasks")
            .addSubcommand(sub => sub.setName("list").setDescription("List all tasks"))
            .addSubcommand(sub => sub
                .setName("get")
                .setDescription("Get one task by id")
                .addStringOption(o => o.setName("id").setDescription("Task id").setRequired(true)))
    ].map(c => c.toJSON());

    client.once(Events.ClientReady, async (c: any) => {
        console.log(`[Discord] Logged in as ${c.user.tag}`);

        if (notifier) notifier.addTransport(transport);

        try {
            const rest = new REST({version: "10"}).setToken(token);
            await rest.put(Routes.applicationCommands(c.user.id), {body: commands});
        } catch (err) {
            console.error("[Discord] Command registration failed:", err);
        }
        if (pinger) pinger.start();
    });

    client.on(Events.InteractionCreate, async (interaction: any) => {
        if (!interaction.isChatInputCommand()) return;
        try {
            if (interaction.commandName === "status") {
                await interaction.reply("Bot online. (status endpoint not yet wired — try `/health`.)");
            } else if (interaction.commandName === "health") {
                if (!pinger) {
                    await interaction.reply("Health URL not configured.");
                    return;
                }
                await interaction.deferReply();
                try {
                    const body = await pinger.api.get("");
                    await interaction.editReply(`HTTP 200 OK\n\`\`\`${String(body).slice(0, 1800)}\`\`\``);
                } catch (err: any) {
                    await interaction.editReply(`Health check failed: ${err.message}`);
                }
            } else if (interaction.commandName === "analysis") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                try {
                    const fen = interaction.options.getString("fen");
                    const depth = interaction.options.getInteger("depth") || 10;

                    const data = await api.post("/engine/analysis", {fen, depth});
                    await interaction.editReply(`**Analysis Complete (Depth ${data.depth})**\n\`\`\`json\n${safeJson(data.bestMove)}\n\`\`\``);
                } catch (err: any) {
                    await interaction.editReply(`Analysis failed: ${err.message}`);
                }
            } else if (interaction.commandName === "bench") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                try {
                    const mode = interaction.options.getString("mode") || "depth";
                    const depth = interaction.options.getInteger("depth") || 9;

                    const data = await api.post("/engine/bench", {mode, depth});
                    await interaction.editReply(`**Benchmark Complete**\n\`\`\`json\n${safeJson(data.data)}\n\`\`\``);
                } catch (err: any) {
                    await interaction.editReply(`Benchmark failed: ${err.message}`);
                }
            } else if (interaction.commandName === "lichess") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                const group = interaction.options.getSubcommandGroup(false);
                const sub = interaction.options.getSubcommand();
                const opt = interaction.options;
                try {
                    if (!group) {
                        if (sub === "start") {
                            const data = await api.post("/lichess/start");
                            await interaction.editReply(data.message || data.status || "Started.");
                        } else if (sub === "stop") {
                            const data = await api.post("/lichess/stop");
                            await interaction.editReply(data.message || data.status || "Stopped.");
                        } else if (sub === "status") {
                            const data = await api.get("/lichess/status");
                            await interaction.editReply(`**Lichess Bot Status**\nRunning: ${data.running ? ":white_check_mark: Yes" : ":x: No"}\nActive Games: ${data.activeGames?.length || 0}\nRate Limited: ${data.rateLimitedFor > 0 ? `Yes (${data.rateLimitedFor}s)` : "No"}\nMax Bot Games: ${data.maxBotGamesFor > 0 ? `Reached (${data.maxBotGamesFor}s)` : "No"}`);
                        }
                    } else if (group === "autoplay") {
                        if (sub === "start") {
                            const payload = stripUndefined({
                                limit: opt.getInteger("limit") ?? undefined,
                                increment: opt.getInteger("increment") ?? undefined,
                                rated: opt.getBoolean("rated") ?? undefined,
                                target: opt.getInteger("target") ?? undefined,
                                mode: opt.getString("mode") ?? undefined,
                                window: opt.getInteger("window") ?? undefined,
                                whiteOpeningId: opt.getString("white_opening_id") ?? undefined,
                                blackOpeningId: opt.getString("black_opening_id") ?? undefined,
                            });
                            const data = await api.post("/lichess/autoplay/start", payload);
                            await interaction.editReply(data.message || data.status || "Autoplay started.");
                        } else if (sub === "stop") {
                            const data = await api.post("/lichess/autoplay/stop");
                            await interaction.editReply(data.message || data.status || "Autoplay stopped.");
                        } else if (sub === "status") {
                            const data = await api.get("/lichess/autoplay/status");
                            await interaction.editReply(`**Autoplay Status**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                        }
                    } else if (group === "challenge") {
                        if (sub === "open") {
                            const payload = stripUndefined({
                                limit: opt.getInteger("limit") ?? undefined,
                                increment: opt.getInteger("increment") ?? undefined,
                                rated: opt.getBoolean("rated") ?? undefined,
                            });
                            const data = await api.post("/lichess/challenge/open", payload);
                            await interaction.editReply(`**Open Challenge**\n\`\`\`json\n${safeJson(data.data ?? data)}\n\`\`\``);
                        } else if (sub === "ai") {
                            const payload = stripUndefined({
                                level: opt.getInteger("level") ?? undefined,
                                limit: opt.getInteger("limit") ?? undefined,
                                increment: opt.getInteger("increment") ?? undefined,
                            });
                            const data = await api.post("/lichess/challenge/ai", payload);
                            await interaction.editReply(`**AI Challenge**\n\`\`\`json\n${safeJson(data.data ?? data)}\n\`\`\``);
                        } else if (sub === "weakest") {
                            const payload = stripUndefined({
                                limit: opt.getInteger("limit") ?? undefined,
                                increment: opt.getInteger("increment") ?? undefined,
                                rated: opt.getBoolean("rated") ?? undefined,
                            });
                            const data = await api.post("/lichess/challenge/weakest", payload);
                            await interaction.editReply(`**Weakest-Bot Hunt**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                        }
                    }
                } catch (err: any) {
                    const label = group ? `${group} ${sub}` : sub;
                    await interaction.editReply(`Lichess \`${label}\` failed: ${err.message}`);
                }
            } else if (interaction.commandName === "teacher") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                const sub = interaction.options.getSubcommand();
                try {
                    if (sub === "run") {
                        const payload = stripUndefined({playerName: interaction.options.getString("player") ?? undefined});
                        const data = await api.post("/analysis/run", payload);
                        await interaction.editReply(`Analysis started. Task: \`${data.taskId ?? "?"}\``);
                    } else if (sub === "stop") {
                        const data = await api.post("/analysis/stop");
                        await interaction.editReply(data.status || "Stopped.");
                    } else if (sub === "status") {
                        const data = await api.get("/analysis/status");
                        await interaction.editReply(`**Analysis Status**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                    } else if (sub === "stats") {
                        const data = await api.get("/analysis/stats");
                        await interaction.editReply(`**Analysis Stats**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                    }
                } catch (err: any) {
                    await interaction.editReply(`Teacher \`${sub}\` failed: ${err.message}`);
                }
            } else if (interaction.commandName === "cutechess") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                const sub = interaction.options.getSubcommand();
                try {
                    if (sub === "gauntlet") {
                        const payload = stripUndefined({
                            preset: interaction.options.getString("preset") ?? undefined,
                            tc: interaction.options.getString("tc") ?? undefined,
                            games: interaction.options.getInteger("games") ?? undefined,
                            concurrency: interaction.options.getInteger("concurrency") ?? undefined,
                        });
                        const data = await api.post("/cutechess/gauntlet", payload);
                        await interaction.editReply(`Gauntlet started. Task: \`${data.taskId ?? "?"}\``);
                    } else if (sub === "selfplay") {
                        const payload = stripUndefined({
                            v1: interaction.options.getString("v1") ?? undefined,
                            v2: interaction.options.getString("v2") ?? undefined,
                            tc: interaction.options.getString("tc") ?? undefined,
                            games: interaction.options.getInteger("games") ?? undefined,
                            depth: interaction.options.getInteger("depth") ?? undefined,
                            nodes: interaction.options.getInteger("nodes") ?? undefined,
                        });
                        const data = await api.post("/selfplay/run", payload);
                        await interaction.editReply(`Self-play started. Task: \`${data.taskId ?? "?"}\``);
                    }
                } catch (err: any) {
                    await interaction.editReply(`Cutechess \`${sub}\` failed: ${err.message}`);
                }
            } else if (interaction.commandName === "pgn") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                try {
                    const pgn = interaction.options.getString("pgn");
                    const data = await api.post("/pgn/ingest", {pgn});
                    await interaction.editReply(`**PGN Ingested**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                } catch (err: any) {
                    await interaction.editReply(`PGN ingest failed: ${err.message}`);
                }
            } else if (interaction.commandName === "chesscom") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                try {
                    const username = interaction.options.getString("username");
                    const months = interaction.options.getInteger("months") ?? undefined;
                    const data = await api.post("/chesscom/fetch", stripUndefined({username, months}));
                    await interaction.editReply(`**Chess.com Fetch**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                } catch (err: any) {
                    await interaction.editReply(`Chess.com fetch failed: ${err.message}`);
                }
            } else if (interaction.commandName === "tasks") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                const sub = interaction.options.getSubcommand();
                try {
                    if (sub === "list") {
                        const data = await api.get("/tasks");
                        await interaction.editReply(`**Tasks**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                    } else if (sub === "get") {
                        const id = interaction.options.getString("id");
                        const data = await api.get(`/tasks/${id}`);
                        await interaction.editReply(`**Task ${id}**\n\`\`\`json\n${safeJson(data)}\n\`\`\``);
                    }
                } catch (err: any) {
                    await interaction.editReply(`Tasks \`${sub}\` failed: ${err.message}`);
                }
            }
        } catch (err) {
            console.error("[Discord] Interaction error:", err);
        }
    });

    await client.login(token);

    return {
        client,
        transport,
        pinger,
        stop: async () => {
            if (pinger) pinger.stop();
            await transport.flush().catch(() => {});
            await client.destroy();
        },
    };
}

function safeJson(value: any): string {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
}

// Drop keys whose value is undefined so omitted slash-command options fall
// through to the route's own defaults rather than overriding them with null.
function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
