const activeTasks = new Map();

export const taskManager = {
    createTask(id, type, payload = {}) {
        const task = {
            id,
            type,
            status: "RUNNING",
            payload,
            progress: null,
            result: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        activeTasks.set(id, task);
        return task;
    },

    updateTaskStatus(id, status, result = null) {
        const task = activeTasks.get(id);
        if (task) {
            task.status = status;
            if (result) task.result = result;
            task.updatedAt = new Date().toISOString();
        }
    },

    updateTaskProgress(id, progress) {
        const task = activeTasks.get(id);
        if (task) {
            task.progress = progress;
            task.updatedAt = new Date().toISOString();
        }
    },

    getTask(id) {
        return activeTasks.get(id) || null;
    },

    getAllTasks() {
        const tasks = Array.from(activeTasks.values());
        // Sort newest first
        tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return tasks;
    }
};
