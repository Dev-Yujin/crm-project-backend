import { getDatabase } from "firebase-admin/database";
import { app } from "../config/firebase.js";
import { getAllTasksForGroupIndexed } from "./task.js";
import { getAllRecurringTasks } from "./recurringTasks.js";

const db = getDatabase(app);

//How many tasks/recurring tasks in a group still have `uuid` in their assignedMembers —
//used by deleteMember to decide whether it's safe to delete outright.
export const countMemberAssignments = async (uuid, groupId) => {
    const [tasks, recurringTasks] = await Promise.all([
        getAllTasksForGroupIndexed(groupId),
        getAllRecurringTasks(groupId),
    ]);

    const taskCount = tasks.filter((task) => (task.assignedMembers ?? []).includes(uuid)).length;
    const recurringTaskCount = recurringTasks.filter((template) => (template.assignedMembers ?? []).includes(uuid)).length;

    return { taskCount, recurringTaskCount };
};

//Replace oldUuid with newUuid in assignedMembers across every task/recurring task in the
//group that references oldUuid — used by deleteMember when the caller supplies a
//reassignment target. Dedupes via Set in case newUuid is already a co-assignee. A single
//multi-location update() applies every change in one Firebase write.
export const reassignMemberAssignments = async (oldUuid, newUuid, groupId) => {
    const [tasks, recurringTasks] = await Promise.all([
        getAllTasksForGroupIndexed(groupId),
        getAllRecurringTasks(groupId),
    ]);

    const matchingTasks = tasks.filter((task) => (task.assignedMembers ?? []).includes(oldUuid));
    const matchingRecurringTasks = recurringTasks.filter((template) => (template.assignedMembers ?? []).includes(oldUuid));

    const updates = {};
    for (const task of matchingTasks) {
        updates[`tasks/${task.id}/assignedMembers`] = [
            ...new Set(task.assignedMembers.map((id) => (id === oldUuid ? newUuid : id))),
        ];
    }
    for (const template of matchingRecurringTasks) {
        updates[`recurringTasks/${template.id}/assignedMembers`] = [
            ...new Set(template.assignedMembers.map((id) => (id === oldUuid ? newUuid : id))),
        ];
    }

    if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
    }

    return {
        tasksTransferred: matchingTasks.length,
        recurringTasksTransferred: matchingRecurringTasks.length,
    };
};
