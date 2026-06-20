import fs from "node:fs";

export class PgnController {
    constructor(
        private taskManager: any,
        private pgnManager: any
    ) {}

    ingestString = async (req: any, res: any) => {
        try {
            const { pgn } = req.body;
            if (!pgn || typeof pgn !== 'string') {
                return res.status(400).json({ error: "pgn string is required" });
            }

            const taskId = `pgn-string-${Date.now()}`;
            await this.taskManager.createTask(taskId, "pgn_ingestion", { type: "string", length: pgn.length });

            res.json({ status: "started", taskId });

            (async () => {
                try {
                    const result = await this.pgnManager.ingestPgnString(pgn);
                    await this.taskManager.updateTaskStatus(taskId, "COMPLETED", result);
                } catch (err: any) {
                    console.error(`[PGN Ingest ${taskId}] Failed:`, err);
                    await this.taskManager.updateTaskStatus(taskId, "FAILED", { error: err.message });
                }
            })();
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    ingestFile = async (req: any, res: any) => {
        try {
            const { filePath } = req.body;
            if (!filePath || !fs.existsSync(filePath)) {
                return res.status(400).json({ error: "Valid filePath is required" });
            }

            const taskId = `pgn-file-${Date.now()}`;
            await this.taskManager.createTask(taskId, "pgn_ingestion", { type: "file", filePath });

            res.json({ status: "started", taskId });

            (async () => {
                try {
                    const result = await this.pgnManager.ingestPgnFile(filePath);
                    await this.taskManager.updateTaskStatus(taskId, "COMPLETED", result);
                } catch (err: any) {
                    console.error(`[PGN Ingest ${taskId}] Failed:`, err);
                    await this.taskManager.updateTaskStatus(taskId, "FAILED", { error: err.message });
                }
            })();
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
