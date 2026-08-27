import { getDatabase } from "firebase-admin/database";
import { app } from "../config/firebase.js";
import {
    validateMembersExist,
    validateServiceForClient,
    addTask,
    TASK_PRIORITY,
} from "./task.js";
import { validateUsersExist } from "./groups.js";
import { validateDepartmentExists } from "./departments.js";
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
export const addRecurringTask = async (clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, createdBy, recurrence, priority = TASK_PRIORITY.MEDIUM, groupId, assignedUsers = [], departmentId = null) => {
    try {
        await validateMembersExist(assignedMembers, groupId);
        await validateUsersExist(assignedUsers, groupId);
        await validateServiceForClient(clientId, serviceId, groupId);
        await validateDepartmentExists(departmentId, groupId);

        const dedupedAssignedUsers = [...new Set(assignedUsers ?? [])];

        const recurringTasksRef = db.ref("recurringTasks");
        const newTemplateRef = recurringTasksRef.push();
        const now = Date.now();

        const template = {
            clientId,
            clientName,
            taskName,
            taskDescription,
            serviceId,
            assignedMembers,
            assignedUsers: dedupedAssignedUsers,
            createdBy,
            priority,
            recurrence,
            departmentId,
            groupId,
            active: true,
            lastRunAt: now,
            nextRunAt: computeNextRun(now, recurrence),
        };

        await newTemplateRef.set(template);

        await addTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, null, createdBy, priority, newTemplateRef.key, null, departmentId, groupId, null, null, dedupedAssignedUsers);

        return { id: newTemplateRef.key, ...template };
    } catch (error) {
        console.error("Error adding recurring task:", error);
        throw error;
    }
};

//Fetch every recurring task template across all groups — used only by the scheduler's cron tick
const getAllRecurringTasksAcrossGroups = async () => {
    const snapshot = await db.ref("recurringTasks").once("value");
    const data = snapshot.val();
    return data ? Object.entries(data).map(([id, template]) => ({ id, ...template })) : [];
};

//Fetch all recurring task templates belonging to a group
export const getAllRecurringTasks = async (groupId) => {
    try {
        const templates = await getAllRecurringTasksAcrossGroups();
        return templates.filter((template) => template.groupId === groupId);
    } catch (error) {
        console.error("Error fetching recurring tasks:", error);
        throw error;
    }
};

//Delete a recurring task template (already-generated task instances are left untouched). Must belong to the caller's group.
export const deleteRecurringTask = async (recurringTaskId, groupId) => {
    try {
        const templateRef = db.ref(`recurringTasks/${recurringTaskId}`);
        const snapshot = await templateRef.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Recurring task not found");
        }

        await templateRef.remove();
        return true;
    } catch (error) {
        console.error("Error deleting recurring task:", error);
        throw error;
    }
};

const setActive = async (recurringTaskId, active, groupId) => {
    const templateRef = db.ref(`recurringTasks/${recurringTaskId}`);
    const snapshot = await templateRef.once("value");

    if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
        throw new Error("Recurring task not found");
    }

    await templateRef.update({ active });
    return { id: recurringTaskId, ...snapshot.val(), active };
};

//Pause a recurring task template — the scheduler skips it until resumed. Must belong to the caller's group.
export const pauseRecurringTask = async (recurringTaskId, groupId) => {
    try {
        return await setActive(recurringTaskId, false, groupId);
    } catch (error) {
        console.error("Error pausing recurring task:", error);
        throw error;
    }
};

//Resume a paused recurring task template. Must belong to the caller's group.
export const resumeRecurringTask = async (recurringTaskId, groupId) => {
    try {
        return await setActive(recurringTaskId, true, groupId);
    } catch (error) {
        console.error("Error resuming recurring task:", error);
        throw error;
    }
};

//Scheduler tick: generate one task instance for every active template that's due (across all groups),
//then advance nextRunAt (catching up past any missed cycles without spamming instances)
export const runDueRecurringTasks = async () => {
    const templates = await getAllRecurringTasksAcrossGroups();
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
                template.id,
                null,
                template.departmentId,
                template.groupId,
                null,
                null,
                template.assignedUsers
            );
            generated.push(task);

            let nextRunAt = computeNextRun(template.nextRunAt, template.recurrence);
            while (nextRunAt <= now) {
                nextRunAt = computeNextRun(nextRunAt, template.recurrence);
            }

            await db.ref(`recurringTasks/${template.id}`).update({
                lastRunAt: now,
                nextRunAt,
            });
        } catch (error) {
            console.error(`Error running recurring task ${template.id}:`, error);
        }
    }

    return generated;
};
