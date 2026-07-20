import { getDatabase, ref, push, set, get, remove, update } from "firebase/database";
import { app } from "../config/firebase.js";
import {
    validateMembersExist,
    validateServiceForClient,
    addTask,
    TASK_PRIORITY,
} from "./task.js";
//Recurring task templates: on their schedule, the scheduler generates a fresh
//one-off Task instance (via addTask) tagged with recurringTaskId

const db = getDatabase(app);

export const RECURRENCE = {
    DAILY: "DAILY",
    WEEKLY: "WEEKLY",
    MONTHLY: "MONTHLY",
};

const computeNextRun = (from, recurrence) => {
    const date = new Date(from);

    if (recurrence === RECURRENCE.DAILY) date.setDate(date.getDate() + 1);
    else if (recurrence === RECURRENCE.WEEKLY) date.setDate(date.getDate() + 7);
    else if (recurrence === RECURRENCE.MONTHLY) date.setMonth(date.getMonth() + 1);

    return date.getTime();
};

//Create a recurring task template and immediately generate its first task instance
export const addRecurringTask = async (clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, createdBy, recurrence, priority = TASK_PRIORITY.MEDIUM) => {
    try {
        await validateMembersExist(assignedMembers);
        await validateServiceForClient(clientId, serviceId);

        const recurringTasksRef = ref(db, "recurringTasks");
        const newTemplateRef = push(recurringTasksRef);
        const now = Date.now();

        const template = {
            clientId,
            clientName,
            taskName,
            taskDescription,
            serviceId,
            assignedMembers,
            createdBy,
            priority,
            recurrence,
            active: true,
            lastRunAt: now,
            nextRunAt: computeNextRun(now, recurrence),
        };

        await set(newTemplateRef, template);

        await addTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, null, createdBy, priority, newTemplateRef.key);

        return { id: newTemplateRef.key, ...template };
    } catch (error) {
        console.error("Error adding recurring task:", error);
        throw error;
    }
};

//Fetch all recurring task templates
export const getAllRecurringTasks = async () => {
    try {
        const snapshot = await get(ref(db, "recurringTasks"));
        const data = snapshot.val();
        return data ? Object.entries(data).map(([id, template]) => ({ id, ...template })) : [];
    } catch (error) {
        console.error("Error fetching recurring tasks:", error);
        throw error;
    }
};

//Delete a recurring task template (already-generated task instances are left untouched)
export const deleteRecurringTask = async (recurringTaskId) => {
    try {
        const templateRef = ref(db, `recurringTasks/${recurringTaskId}`);
        const snapshot = await get(templateRef);

        if (!snapshot.exists()) {
            throw new Error("Recurring task not found");
        }

        await remove(templateRef);
        return true;
    } catch (error) {
        console.error("Error deleting recurring task:", error);
        throw error;
    }
};

const setActive = async (recurringTaskId, active) => {
    const templateRef = ref(db, `recurringTasks/${recurringTaskId}`);
    const snapshot = await get(templateRef);

    if (!snapshot.exists()) {
        throw new Error("Recurring task not found");
    }

    await update(templateRef, { active });
    return { id: recurringTaskId, ...snapshot.val(), active };
};

//Pause a recurring task template — the scheduler skips it until resumed
export const pauseRecurringTask = async (recurringTaskId) => {
    try {
        return await setActive(recurringTaskId, false);
    } catch (error) {
        console.error("Error pausing recurring task:", error);
        throw error;
    }
};

//Resume a paused recurring task template
export const resumeRecurringTask = async (recurringTaskId) => {
    try {
        return await setActive(recurringTaskId, true);
    } catch (error) {
        console.error("Error resuming recurring task:", error);
        throw error;
    }
};

//Scheduler tick: generate one task instance for every active template that's due,
//then advance nextRunAt (catching up past any missed cycles without spamming instances)
export const runDueRecurringTasks = async () => {
    const templates = await getAllRecurringTasks();
    const now = Date.now();
    const generated = [];

    for (const template of templates) {
        if (!template.active || template.nextRunAt > now) continue;

        try {
            const task = await addTask(
                template.clientId,
                template.clientName,
                template.taskName,
                template.taskDescription,
                template.serviceId,
                template.assignedMembers,
                null,
                template.createdBy,
                template.priority,
                template.id
            );
            generated.push(task);

            let nextRunAt = computeNextRun(template.nextRunAt, template.recurrence);
            while (nextRunAt <= now) {
                nextRunAt = computeNextRun(nextRunAt, template.recurrence);
            }

            await update(ref(db, `recurringTasks/${template.id}`), {
                lastRunAt: now,
                nextRunAt,
            });
        } catch (error) {
            console.error(`Error running recurring task ${template.id}:`, error);
        }
    }

    return generated;
};
