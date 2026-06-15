import { taskManager } from "../taskManager.js";

export const tasksController = {
    getAllTasks(req, res) {
        try {
            const tasks = taskManager.getAllTasks();
            res.json(tasks);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    },

    getTask(req, res) {
        try {
            const task = taskManager.getTask(req.params.id);
            if (!task) return res.status(404).json({ error: "Task not found" });
            res.json(task);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
};
