import { getDatabase, ServerValue } from "firebase-admin/database";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";
import { validateTaskStatusExists } from "./taskStatuses.js";
import { validateDepartmentExists } from "./departments.js";
import { fetchMemberGroupId } from "../utils/groups.js";
import { validateUsersExist } from "./groups.js";
import { CUSTOM_FIELD_ENTITY_TYPES, validateCustomFieldValues, toStoredCustomFields } from "./customFields.js";

const db = getDatabase(app);

export const TASK_PRIORITY = {
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    URGENT: "URGENT",
};

//A task may be assigned to admins only, so an empty list here is valid — not every task needs a member
export const validateMembersExist = async (memberUuids, groupId) => {
    if (!memberUuids || memberUuids.length === 0) {
        return;
    }

    const result = await pool.query("SELECT uuid FROM members WHERE uuid = ANY($1) AND group_id = $2", [memberUuids, groupId]);
    const foundUuids = new Set(result.rows.map((row) => row.uuid));
    const missing = memberUuids.filter((uuid) => !foundUuids.has(uuid));

    if (missing.length > 0) {
        throw new Error(`Member(s) not found: ${missing.join(", ")}`);
    }
};

//A task's service must be one of the services its client actually avails, and the client must belong to the caller's group
export const validateServiceForClient = async (clientId, serviceId, groupId) => {
    const clientSnapshot = await db.ref(`clients/${clientId}`).once("value");

    if (!clientSnapshot.exists() || clientSnapshot.val().groupId !== groupId) {
        throw new Error("Client not found");
    }

    const availedServices = clientSnapshot.val().servicesAvailed ?? [];

    if (!availedServices.includes(serviceId)) {
        throw new Error("This service is not offered to the selected client");
    }
};

export const mapRevisions = (revisions) =>
    revisions ? Object.entries(revisions).map(([id, revision]) => ({ id, ...revision })) : [];

//Trims free text and stores null rather than "" — used for `source`
const normalizeSource = (value) => {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
};

//Trims free text and stores null rather than "" — used for `notes`
const normalizeNotes = (value) => {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
};

//Trims and validates a URL — only http(s) is accepted (javascript:/data: URLs would be
//an XSS vector, since the frontend renders liveLink as a clickable anchor)
export const normalizeLiveLink = (value) => {
    const trimmed = value.trim();
    if (trimmed === "") return null;

    if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error("liveLink must start with http:// or https://");
    }

    return trimmed;
};

//Fetch all tasks belonging to a group
export const getAllTasks = async (groupId) => {
    try {
        const tasksSnapshot = await db.ref("tasks").once("value");
        const tasksData = tasksSnapshot.val();
        const tasks = tasksData
            ? Object.entries(tasksData).map(([id, task]) => ({
                  id,
                  ...task,
                  assignedMembers: task.assignedMembers ?? [],
                  revisions: mapRevisions(task.revisions),
              }))
            : [];
        return tasks.filter((task) => task.groupId === groupId);
    } catch (error) {
        console.error("Error fetching all tasks:", error);
        throw error;
    }
};

//Like getAllTasks, but uses the existing groupId index for a server-side filtered
//read instead of downloading every group's tasks and filtering in memory. Used by
//taskStorageBreakdown, which is polled from the frontend every 15s — the full-table
//read getAllTasks does is fine for on-demand calls but not for a recurring poll.
export const getAllTasksForGroupIndexed = async (groupId) => {
    try {
        const tasksSnapshot = await db.ref("tasks").orderByChild("groupId").equalTo(groupId).once("value");
        const tasksData = tasksSnapshot.val();
        return tasksData
            ? Object.entries(tasksData).map(([id, task]) => ({ id, ...task }))
            : [];
    } catch (error) {
        console.error("Error fetching indexed tasks for group:", error);
        throw error;
    }
};

//Fetch only the tasks assigned to a given member, scoped to that member's own group
export const getTasksForMember = async (memberUuid) => {
    try {
        const groupId = await fetchMemberGroupId(memberUuid);
        const tasks = await getAllTasks(groupId);
        return tasks.filter((task) => task.assignedMembers.includes(memberUuid));
    } catch (error) {
        console.error("Error fetching tasks for member:", error);
        throw error;
    }
};

//Add a new task (created by a user, assigned to one or more members, tied to one of the client's availed services)
//statusId is optional and freely chosen from the user-managed task status catalog — there is no fixed workflow
//recurringTaskId is set internally when a recurring task template generates an instance — not exposed on the public addTask mutation
export const addTask = async (clientId, clientName, taskName, taskDescription, serviceId, assignedMembers = [], dueDate = null, createdBy, priority = TASK_PRIORITY.MEDIUM, recurringTaskId = null, statusId = null, departmentId = null, groupId, liveLink = null, source = null, assignedUsers = [], notes = null, customFields = null) => {
    try {
        await validateMembersExist(assignedMembers, groupId);
        await validateUsersExist(assignedUsers, groupId);
        await validateServiceForClient(clientId, serviceId, groupId);
        await validateTaskStatusExists(statusId, groupId);
        await validateDepartmentExists(departmentId, groupId);
        await validateCustomFieldValues(customFields, CUSTOM_FIELD_ENTITY_TYPES.TASK, groupId);

        const normalizedLiveLink = liveLink != null ? normalizeLiveLink(liveLink) : null;
        const normalizedSource = source != null ? normalizeSource(source) : null;
        const normalizedNotes = notes != null ? normalizeNotes(notes) : null;
        const dedupedAssignedUsers = [...new Set(assignedUsers ?? [])];
        const storedCustomFields = toStoredCustomFields(customFields) ?? {};

        const tasksRef = db.ref("tasks");
        const newTaskRef = tasksRef.push();
        await newTaskRef.set({
            clientId,
            clientName,
            taskName,
            taskDescription,
            serviceId,
            assignedMembers,
            assignedUsers: dedupedAssignedUsers,
            dueDate,
            createdBy,
            priority,
            recurringTaskId,
            statusId,
            departmentId,
            groupId,
            liveLink: normalizedLiveLink,
            source: normalizedSource,
            notes: normalizedNotes,
            customFields: storedCustomFields,
            createdAt: ServerValue.TIMESTAMP,
        });

        return {
            id: newTaskRef.key,
            clientId,
            clientName,
            taskName,
            taskDescription,
            serviceId,
            assignedMembers,
            assignedUsers: dedupedAssignedUsers,
            dueDate,
            createdBy,
            priority,
            recurringTaskId,
            statusId,
            departmentId,
            groupId,
            liveLink: normalizedLiveLink,
            source: normalizedSource,
            notes: normalizedNotes,
            customFields: storedCustomFields,
            revisions: [],
        };
    } catch (error) {
        console.error("Error adding task:", error);
        throw error;
    }
};

//Delete a task by its ID (must belong to the caller's group)
export const deleteTask = async (taskId, groupId) => {
    try {
        const taskRef = db.ref(`tasks/${taskId}`);
        const taskSnapshot = await taskRef.once("value");

        if (!taskSnapshot.exists() || taskSnapshot.val().groupId !== groupId) {
            throw new Error("Task not found");
        }

        await taskRef.remove();
        return { id: taskId, ...taskSnapshot.val(), revisions: mapRevisions(taskSnapshot.val().revisions) };
    } catch (error) {
        console.error("Error deleting task:", error);
        throw error;
    }
};

//Edit a task's details, including freely setting its statusId — there is no fixed workflow gating this.
//This is a member action (member bearer auth, not a user session) — callerGroupId comes from the
//member's own verified token and must match the task's stored groupId, or the task is treated as not found.
export const editTask = async (taskId, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, priority, statusId, departmentId, liveLink, source, notes, assignedUsers, customFields } = {}, callerGroupId) => {
    try {
        const taskRef = db.ref(`tasks/${taskId}`);
        const taskSnapshot = await taskRef.once("value");

        if (!taskSnapshot.exists() || taskSnapshot.val().groupId !== callerGroupId) {
            throw new Error("Task not found");
        }

        const task = taskSnapshot.val();
        const groupId = task.groupId;

        if (assignedMembers !== undefined) {
            await validateMembersExist(assignedMembers, groupId);
        }

        if (assignedUsers !== undefined) {
            await validateUsersExist(assignedUsers, groupId);
        }

        if (clientId !== undefined || serviceId !== undefined) {
            await validateServiceForClient(
                clientId !== undefined ? clientId : task.clientId,
                serviceId !== undefined ? serviceId : task.serviceId,
                groupId
            );
        }

        if (statusId !== undefined) {
            await validateTaskStatusExists(statusId, groupId);
        }

        if (departmentId !== undefined) {
            await validateDepartmentExists(departmentId, groupId);
        }

        if (customFields !== undefined) {
            await validateCustomFieldValues(customFields, CUSTOM_FIELD_ENTITY_TYPES.TASK, groupId);
        }

        // Argument not provided (undefined) -> leave stored value untouched.
        // Argument provided as null or "" -> clear the field.
        const normalizedLiveLink = liveLink !== undefined ? (liveLink == null ? null : normalizeLiveLink(liveLink)) : undefined;
        const normalizedSource = source !== undefined ? (source == null ? null : normalizeSource(source)) : undefined;
        const normalizedNotes = notes !== undefined ? (notes == null ? null : normalizeNotes(notes)) : undefined;

        const updatedTaskData = {
            ...(clientId !== undefined && { clientId }),
            ...(clientName !== undefined && { clientName }),
            ...(taskName !== undefined && { taskName }),
            ...(taskDescription !== undefined && { taskDescription }),
            ...(serviceId !== undefined && { serviceId }),
            ...(assignedMembers !== undefined && { assignedMembers }),
            ...(dueDate !== undefined && { dueDate }),
            ...(priority !== undefined && { priority }),
            ...(statusId !== undefined && { statusId }),
            ...(departmentId !== undefined && { departmentId }),
            ...(liveLink !== undefined && { liveLink: normalizedLiveLink }),
            ...(source !== undefined && { source: normalizedSource }),
            ...(notes !== undefined && { notes: normalizedNotes }),
            ...(assignedUsers !== undefined && { assignedUsers: [...new Set(assignedUsers ?? [])] }),
            ...(customFields !== undefined && { customFields: toStoredCustomFields(customFields) }),
        };

        const finalData = { ...task, ...updatedTaskData };
        await taskRef.set(finalData);

        return { id: taskId, ...finalData, revisions: mapRevisions(finalData.revisions) };
    } catch (error) {
        console.error("Error editing task:", error);
        throw error;
    }
};

//Records a submitted work item (link + optional note) on a task, on behalf of memberUuid.
//Callable anytime by an assigned member — not gated by status. Called by both actor types:
//a member submitting their OWN work (memberUuid comes from their token) and a user (admin)
//recording a submission on behalf of one of the task's assignees. callerGroupId is required
//either way and must match the task's own group.
export const submitTask = async (taskId, memberUuid, link, note = null, callerGroupId) => {
    try {
        const taskRef = db.ref(`tasks/${taskId}`);
        const taskSnapshot = await taskRef.once("value");

        if (!taskSnapshot.exists() || taskSnapshot.val().groupId !== callerGroupId) {
            throw new Error("Task not found");
        }

        const task = taskSnapshot.val();

        if (!(task.assignedMembers ?? []).includes(memberUuid)) {
            throw new Error("This member is not assigned to this task");
        }

        const submission = {
            link,
            note,
            submittedBy: memberUuid,
            submittedAt: ServerValue.TIMESTAMP,
        };

        await taskRef.update({ submission });

        return {
            id: taskId,
            ...task,
            revisions: mapRevisions(task.revisions),
            submission: { link, note, submittedBy: memberUuid, submittedAt: null },
        };
    } catch (error) {
        console.error("Error submitting task:", error);
        throw error;
    }
};

//A user leaves a review comment on a task, logged to its revision history. Callable anytime — not gated by status. Must belong to the caller's group.
export const reviewTask = async (taskId, reviewedBy, comment, groupId) => {
    try {
        const taskRef = db.ref(`tasks/${taskId}`);
        const taskSnapshot = await taskRef.once("value");

        if (!taskSnapshot.exists() || taskSnapshot.val().groupId !== groupId) {
            throw new Error("Task not found");
        }

        const task = taskSnapshot.val();

        const revisionsRef = db.ref(`tasks/${taskId}/revisions`);
        const newRevisionRef = revisionsRef.push();
        await newRevisionRef.set({
            comment,
            reviewedBy,
            reviewedAt: ServerValue.TIMESTAMP,
        });

        return {
            id: taskId,
            ...task,
            revisions: [
                ...mapRevisions(task.revisions),
                { id: newRevisionRef.key, comment, reviewedBy, reviewedAt: null },
            ],
        };
    } catch (error) {
        console.error("Error reviewing task:", error);
        throw error;
    }
};
