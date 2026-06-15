import { PgnManager } from "../pgnManager.js";
import { dbClient } from "../dbClient.js";
import { taskManager } from "../taskManager.js";
import fs from "node:fs";

export const pgnController = {
    async ingestString(req, res) {
        try {
            const { pgn } = req.body;
            if (!pgn || typeof pgn !== 'string') {
                return res.status(400).json({ error: "pgn string is required" });
            }

            const taskId = `pgn-ingest-${Date.now()}`;
            taskManager.createTask(taskId, "pgn_ingestion", { type: "string", length: pgn.length });

            res.json({ status: "started", taskId });

            // Run in background
            (async () => {
                try {
                    const pgnManager = new PgnManager(dbClient);
                    const result = await pgnManager.ingestPgnString(pgn);
                    taskManager.updateTaskStatus(taskId, "COMPLETED", result);
                } catch (err) {
                    console.error(`[PGN Ingest ${taskId}] Failed:`, err);
                    taskManager.updateTaskStatus(taskId, "FAILED", { error: err.message });
                }
            })();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    },

    async ingestFile(req, res) {
        try {
            const { filePath } = req.body;
            if (!filePath || !fs.existsSync(filePath)) {
                return res.status(400).json({ error: "Valid filePath is required" });
            }

            const taskId = `pgn-ingest-${Date.now()}`;
            taskManager.createTask(taskId, "pgn_ingestion", { type: "file", filePath });

            res.json({ status: "started", taskId });

            // Run in background
            (async () => {
                try {
                    const pgnManager = new PgnManager(dbClient);
                    const result = await pgnManager.ingestPgnFile(filePath);
                    taskManager.updateTaskStatus(taskId, "COMPLETED", result);
                } catch (err) {
                    console.error(`[PGN Ingest ${taskId}] Failed:`, err);
                    taskManager.updateTaskStatus(taskId, "FAILED", { error: err.message });
                }
            })();
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
};
