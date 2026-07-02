import { taskClient } from "./dbClient.js";

// TODO: migrate to ts

const CONSUMER_ID = "jewkiebot";

export const taskManager = {
    async createTask(id, type, payload = {}) {
        return taskClient.createTask({
            id,
            consumer_id: CONSUMER_ID,
            type,
            status: "RUNNING",
            payload
        });
    },

    async updateTaskStatus(id, status, result = null) {
        return taskClient.updateTask(id, { status, result });
    },

    async updateTaskProgress(id, progress) {
        return taskClient.updateTask(id, { progress });
    },

    async getTask(id) {
        return taskClient.getTaskById(id);
    },

    async getAllTasks() {
        return taskClient.getTasks(CONSUMER_ID);
    }
};
