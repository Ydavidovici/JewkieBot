import {ApiTransport} from "./apiTransport.js";

const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const DEFAULT_HEALTH_INTERVAL_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

const LEVEL_EMOJI = {info: ":information_source:", warn: ":warning:", error: ":x:", fatal: ":rotating_light:"};

export class DiscordTransport {
    constructor({channelId, sendFn, minLevel = "info", flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS} = {}) {
        if (!channelId) throw new Error("DiscordTransport requires channelId");
        if (typeof sendFn !== "function") throw new Error("DiscordTransport requires sendFn(channelId, content)");
        this.channelId = channelId;
        this.sendFn = sendFn;
        this.minLevel = minLevel;
        this.flushIntervalMs = flushIntervalMs;
        this.buffer = [];
        this.timer = null;
    }

    send(event) {
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

        let EmbedBuilder;
        try {
            const discord = await import("discord.js");
            EmbedBuilder = discord.EmbedBuilder;
        } catch (err) {
            console.error("[Discord] Cannot flush embeds without discord.js", err);
            return;
        }

        const drained = this.buffer.splice(0);
        const embedChunks = [];
        let currentChunk = [];

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
                await this.sendFn(this.channelId, { embeds });
            } catch (err) {
                console.error("[Discord] Send failed:", err);
            }
        }
    }
}

export class HealthPinger {
    constructor({url, sendFn, channelId, intervalMs = DEFAULT_HEALTH_INTERVAL_MS, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, label = "backend"} = {}) {
        if (!url) throw new Error("HealthPinger requires url");
        this.api = new ApiTransport({ baseUrl: url });
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
        let detail = null;
        try {
            await this.api.get("", { signal: ac.signal, silent: true });
            up = true;
            detail = null;
        } catch (err) {
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

    async _announce(line) {
        if (!this.sendFn || !this.channelId) return;
        try { await this.sendFn(this.channelId, line); }
        catch (err) { console.error("[HealthPinger] Send failed:", err); }
    }
}

export async function createDiscordBot({token, channelId, notifier, healthUrl, apiUrl, intents}) {
    if (!token) throw new Error("createDiscordBot requires token");
    if (!channelId) throw new Error("createDiscordBot requires channelId");

    let discord;
    try {
        discord = await import("discord.js");
    } catch (err) {
        throw new Error("discord.js is not installed. Run: bun add discord.js");
    }

    const {Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder} = discord;
    const client = new Client({
        intents: intents ?? [GatewayIntentBits.Guilds],
    });

    const sendFn = async (chId, content) => {
        const channel = await client.channels.fetch(chId);
        if (!channel || !channel.isTextBased()) {
            throw new Error(`Channel ${chId} is not text-based`);
        }
        await channel.send(content);
    };

    const transport = new DiscordTransport({channelId, sendFn});

    const pinger = healthUrl
        ? new HealthPinger({url: healthUrl, sendFn, channelId})
        : null;

    const api = apiUrl ? new ApiTransport({ baseUrl: apiUrl }) : null;

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
            .addSubcommand(sub => sub.setName("status").setDescription("Check Lichess bot status")),
    ].map(c => c.toJSON());

    client.once(Events.ClientReady, async (c) => {
        console.log(`[Discord] Logged in as ${c.user.tag}`);
        if (notifier) notifier.addTransport(transport); // Only add transport once we are connected
        try {
            const rest = new REST({version: "10"}).setToken(token);
            await rest.put(Routes.applicationCommands(c.user.id), {body: commands});
        } catch (err) {
            console.error("[Discord] Command registration failed:", err);
        }
        if (pinger) pinger.start();
    });

    client.on(Events.InteractionCreate, async (interaction) => {
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
                } catch (err) {
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
                } catch (err) {
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
                } catch (err) {
                    await interaction.editReply(`Benchmark failed: ${err.message}`);
                }
            } else if (interaction.commandName === "lichess") {
                if (!api) return interaction.reply("API URL not configured.");
                await interaction.deferReply();
                try {
                    const sub = interaction.options.getSubcommand();
                    if (sub === "start") {
                        const data = await api.post("/lichess/start");
                        await interaction.editReply(data.message || data.status || "Started.");
                    } else if (sub === "stop") {
                        const data = await api.post("/lichess/stop");
                        await interaction.editReply(data.message || data.status || "Stopped.");
                    } else if (sub === "status") {
                        const data = await api.get("/lichess/status");
                        await interaction.editReply(`**Lichess Bot Status**\nRunning: ${data.running ? ":white_check_mark: Yes" : ":x: No"}\nActive Games: ${data.activeGames?.length || 0}\nRate Limited: ${data.rateLimitedFor > 0 ? `Yes (${data.rateLimitedFor}s)` : "No"}`);
                    }
                } catch (err) {
                    const sub = interaction.options.getSubcommand();
                    await interaction.editReply(`Lichess \`${sub}\` failed: ${err.message}`);
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

function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
}
