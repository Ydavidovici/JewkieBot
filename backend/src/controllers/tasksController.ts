export class TasksController {
    constructor(private taskManager: any) {}

    getAllTasks = async (req: any, res: any) => {
        try {
            const tasks = await this.taskManager.getAllTasks();
            res.json(tasks);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    getTask = async (req: any, res: any) => {
        try {
            const task = await this.taskManager.getTask(req.params.id);
            if (!task) return res.status(404).json({ error: "Task not found" });
            res.json(task);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }
}
