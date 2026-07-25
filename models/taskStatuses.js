import { getDatabase, ref, push, set, get, remove, update } from "firebase/database";
import { app } from "../config/firebase.js";
//A user-managed catalog of task statuses (e.g. "Pending", "On Going", "Submitted", "Completed")
//There is no fixed workflow — users define whatever statuses they want and set them freely on a task

const db = getDatabase(app);

//Fetch all task statuses
export const getAllTaskStatuses = async () => {
    try {
        const snapshot = await get(ref(db, "taskStatuses"));
        const data = snapshot.val();
        return data ? Object.entries(data).map(([id, taskStatus]) => ({ id, ...taskStatus })) : [];
    } catch (error) {
        console.error("Error fetching task statuses:", error);
        throw error;
    }
};

//Add a new task status
export const addTaskStatus = async (name) => {
    try {
        const taskStatusesRef = ref(db, "taskStatuses");
        const newTaskStatusRef = push(taskStatusesRef);
        await set(newTaskStatusRef, { name });
        return { id: newTaskStatusRef.key, name };
    } catch (error) {
        console.error("Error adding task status:", error);
        throw error;
    }
};

//Update a task status's name
export const updateTaskStatus = async (taskStatusId, name) => {
    try {
        const taskStatusRef = ref(db, `taskStatuses/${taskStatusId}`);
        const snapshot = await get(taskStatusRef);

        if (!snapshot.exists()) {
            throw new Error("Task status not found");
        }

        await update(taskStatusRef, { name });
        return { id: taskStatusId, name };
    } catch (error) {
        console.error("Error updating task status:", error);
        throw error;
    }
};

//Delete a task status
export const deleteTaskStatus = async (taskStatusId) => {
    try {
        const taskStatusRef = ref(db, `taskStatuses/${taskStatusId}`);
        const snapshot = await get(taskStatusRef);

        if (!snapshot.exists()) {
            throw new Error("Task status not found");
        }

        await remove(taskStatusRef);
        return { id: taskStatusId, ...snapshot.val() };
    } catch (error) {
        console.error("Error deleting task status:", error);
        throw error;
    }
};

//Validate that a task status ID exists in the catalog
export const validateTaskStatusExists = async (taskStatusId) => {
    if (taskStatusId == null) {
        return;
    }

    const taskStatuses = await getAllTaskStatuses();
    const exists = taskStatuses.some((taskStatus) => taskStatus.id === taskStatusId);

    if (!exists) {
        throw new Error(`Task status not found: ${taskStatusId}`);
    }
};
