import {LichessBot} from "../lichessBot.ts";

export class LichessController {
    private lichessBotInstance: LichessBot | null = null;

    constructor(
        private getToken: () => string | undefined,
        private lichessEngineFactory: any,
        private maxConcurrentGames: number,
        private notifier: any,
        private BotClass: typeof LichessBot = LichessBot,
    ) {}

    start = async (req: any, res: any): Promise<any> => {
        if (this.lichessBotInstance) {
            return res.status(400).json({error: "Bot is already running."});
        }

        const token = this.getToken();

        if (!token) {
            return res.status(400).json({error: "Missing Lichess Token"});
        }

        const instance = new this.BotClass(token, this.lichessEngineFactory, {
            maxConcurrentGames: this.maxConcurrentGames,
            notifier: this.notifier,
        });

        try {
            await instance.start();

            this.lichessBotInstance = instance;

            this.notifier.info("[Server] Lichess bot started", {maxConcurrentGames: this.maxConcurrentGames});
            res.json({status: "success", message: `Lichess Bot started.`});
        } catch (err) {
            this.notifier.error("[Server] Lichess bot failed to start", {message: err?.message});
            try { instance.stop(); } catch (_) {}

            res.status(500).json({error: err.message});
        }
    };

    stop = async (req: any, res: any): Promise<any> => {
        if (!this.lichessBotInstance) {
            return res.json({status: "ignored", message: "Bot was not running."});
        }

        try {
            if (typeof this.lichessBotInstance.stop === "function") {
                this.lichessBotInstance.stop();
            }
            this.lichessBotInstance = null;
            res.json({status: "success", message: "Lichess Bot stopped."});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    };

    getStatus = async (req: any, res: any): Promise<any> => {
        const rateLimitedFor = this.lichessBotInstance ? this.lichessBotInstance._rateLimitRemainingSec() : 0;
        const maxBotGamesFor = this.lichessBotInstance ? this.lichessBotInstance._maxBotGamesRemainingSec() : 0;

        if (this.lichessBotInstance && !this.lichessBotInstance.botProfile) {
            this.lichessBotInstance._ensureProfile().catch(() => {
            });
        }

        res.json({
            running: !!this.lichessBotInstance,
            profile: this.lichessBotInstance ? this.lichessBotInstance.botProfile : null,
            activeGames: this.lichessBotInstance ? Array.from(this.lichessBotInstance.activeGames) : [],
            maxConcurrentGames: this.lichessBotInstance ? this.lichessBotInstance.maxConcurrentGames : this.maxConcurrentGames,
            rateLimitedFor,
            maxBotGamesFor,
            declinedCount: this.lichessBotInstance ? this.lichessBotInstance.recentlyDeclined.size : 0,
        });
    };

    openChallenge = async (req: any, res: any): Promise<any> => {
        if (!this.lichessBotInstance) {
            return res.status(400).json({error: "Bot not running"});
        }

        // FIXME: all these default settings should be a type
        const {limit = 180, increment = 0, rated = true} = req.body ?? {};

        try {
            const result = await this.lichessBotInstance.createOpenChallenge(limit, increment, rated);
            res.json({status: "success", data: result});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    };

    challengeAI = async (req: any, res: any): Promise<any> => {
        if (!this.lichessBotInstance) {
            return res.status(400).json({error: "Bot not running"});
        }

        // FIXME: all these default settings should be a type
        const {level = 1, limit = 180, increment = 0} = req.body ?? {};

        try {
            const result = await this.lichessBotInstance.createAiChallenge(level, limit, increment);
            res.json({status: "success", data: result});
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    };

    challengeWeakest = async (req: any, res: any): Promise<any> => {
        if (!this.lichessBotInstance) {
            return res.status(400).json({error: "Bot not running"});
        }

        // FIXME: all these default settings should be a type
        const {limit = 180, increment = 0, rated = true} = req.body ?? {};

        try {
            const result = await this.lichessBotInstance.huntWeakestBot(limit, increment, rated);
            res.json(result);
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    };

    startAutoplay = async (req: any, res: any): Promise<any> => {
        if (!this.lichessBotInstance) {
            return res.status(400).json({error: "Bot not running"});
        }

        // FIXME: all these default settings should be a type
        const {
            limit = 180,
            increment = 2,
            rated = true,
            target = 1,
            mode = "near",
            window = 200,
            whiteOpeningId = null,
            blackOpeningId = null,
            opponentType = "both",
        } = req.body ?? {};

        this.lichessBotInstance.startAutoplay({limit, increment, rated, target, mode, window, whiteOpeningId, blackOpeningId, opponentType});

        res.json({
            status: "success",
            message: `Autoplay started (${limit}+${increment} ${rated ? "rated" : "casual"}, target=${target})`,
            autoplay: this.lichessBotInstance.autoplayStatus(),
        });
    };

    stopAutoplay = async (req: any, res: any): Promise<any> => {
        if (!this.lichessBotInstance) {
            return res.status(400).json({error: "Bot not running"});
        }

        this.lichessBotInstance.stopAutoplay();

        res.json({status: "success", message: "Autoplay stopped"});
    };

    getAutoPlayStatus = async (req: any, res: any): Promise<any> => {
        if (!this.lichessBotInstance) {
            return res.json({enabled: false, botRunning: false});
        }

        res.json(this.lichessBotInstance.autoplayStatus());
    }
}