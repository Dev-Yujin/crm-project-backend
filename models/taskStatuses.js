import { getDatabase } from "firebase-admin/database";
import { app } from "../config/firebase.js";
//A user-managed catalog of task statuses (e.g. "Pending", "On Going", "Submitted", "Completed") — scoped per group
//There is no fixed workflow — users define whatever statuses they want and set them freely on a task

const db = getDatabase(app);

//Fetch all task statuses belonging to a group
export const getAllTaskStatuses = async (groupId) => {
    try {
        const snapshot = await db.ref("taskStatuses").once("value");
        const data = snapshot.val();
        const taskStatuses = data ? Object.entries(data).map(([id, taskStatus]) => ({ id, ...taskStatus })) : [];
        return taskStatuses.filter((taskStatus) => taskStatus.groupId === groupId);
    } catch (error) {
        console.error("Error fetching task statuses:", error);
        throw error;
    }
};

//Add a new task status to a group's catalog
export const addTaskStatus = async (name, groupId) => {
    try {
        const taskStatusesRef = db.ref("taskStatuses");
        const newTaskStatusRef = taskStatusesRef.push();
        await newTaskStatusRef.set({ name, groupId });
        return { id: newTaskStatusRef.key, name, groupId };
    } catch (error) {
        console.error("Error adding task status:", error);
        throw error;
    }
};

//Update a task status's name (must belong to the caller's group)
export const updateTaskStatus = async (taskStatusId, name, groupId) => {
    try {
        const taskStatusRef = db.ref(`taskStatuses/${taskStatusId}`);
        const snapshot = await taskStatusRef.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Task status not found");
        }

        await taskStatusRef.update({ name });
        return { id: taskStatusId, name, groupId };
    } catch (error) {
        console.error("Error updating task status:", error);
        throw error;
    }
};

//Delete a task status (must belong to the caller's group)
export const deleteTaskStatus = async (taskStatusId, groupId) => {
    try {
        const taskStatusRef = db.ref(`taskStatuses/${taskStatusId}`);
        const snapshot = await taskStatusRef.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Task status not found");
        }

        await taskStatusRef.remove();
        return { id: taskStatusId, ...snapshot.val() };
    } catch (error) {
        console.error("Error deleting task status:", error);
        throw error;
    }
};

//No-op if taskStatusId is null, otherwise throws if it's not in the caller's group's catalog
export const validateTaskStatusExists = async (taskStatusId, groupId) => {
    if (taskStatusId == null) {
        return;
    }

    const taskStatuses = await getAllTaskStatuses(groupId);
    const exists = taskStatuses.some((taskStatus) => taskStatus.id === taskStatusId);

    if (!exists) {
        throw new Error(`Task status not found: ${taskStatusId}`);
    }
};
