import { taskManager } from "../taskManager.js";

export const tasksController = {
    async getAllTasks(req, res) {
        try {
            const tasks = await taskManager.getAllTasks();
            res.json(tasks);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    },

    async getTask(req, res) {
        try {
            const task = await taskManager.getTask(req.params.id);
            if (!task) return res.status(404).json({ error: "Task not found" });
            res.json(task);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
};
