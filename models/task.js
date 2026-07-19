import { getDatabase, ref, push, set, get, remove, update, serverTimestamp } from "firebase/database";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";

const db = getDatabase(app);

export const TASK_STATUS = {
    PENDING: "PENDING",
    SUBMITTED: "SUBMITTED",
    FOR_REVISION: "FOR_REVISION",
    COMPLETED: "COMPLETED",
};

export const TASK_PRIORITY = {
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    URGENT: "URGENT",
};

const validateMembersExist = async (memberUuids) => {
    if (!memberUuids || memberUuids.length === 0) {
        throw new Error("At least one assigned member is required");
    }

    const result = await pool.query("SELECT uuid FROM members WHERE uuid = ANY($1)", [memberUuids]);
    const foundUuids = new Set(result.rows.map((row) => row.uuid));
    const missing = memberUuids.filter((uuid) => !foundUuids.has(uuid));

    if (missing.length > 0) {
        throw new Error(`Member(s) not found: ${missing.join(", ")}`);
    }
};

//A task's service must be one of the services its client actually avails
const validateServiceForClient = async (clientId, serviceId) => {
    const clientSnapshot = await get(ref(db, `clients/${clientId}`));

    if (!clientSnapshot.exists()) {
        throw new Error("Client not found");
    }

    const availedServices = clientSnapshot.val().servicesAvailed ?? [];

    if (!availedServices.includes(serviceId)) {
        throw new Error("This service is not offered to the selected client");
    }
};

const mapRevisions = (revisions) =>
    revisions ? Object.entries(revisions).map(([id, revision]) => ({ id, ...revision })) : [];

//Fetch All Tasks
export const getAllTasks = async () => {
    try {
        const tasksSnapshot = await get(ref(db, "tasks"));
        const tasksData = tasksSnapshot.val();
        return tasksData
            ? Object.entries(tasksData).map(([id, task]) => ({
                  id,
                  ...task,
                  assignedMembers: task.assignedMembers ?? [],
                  revisions: mapRevisions(task.revisions),
              }))
            : [];
    } catch (error) {
        console.error("Error fetching all tasks:", error);
        throw error;
    }
};

//Fetch only the tasks assigned to a given member
export const getTasksForMember = async (memberUuid) => {
    try {
        const tasks = await getAllTasks();
        return tasks.filter((task) => task.assignedMembers.includes(memberUuid));
    } catch (error) {
        console.error("Error fetching tasks for member:", error);
        throw error;
    }
};

//Add a new task (created by a user, assigned to one or more members, tied to one of the client's availed services)
export const addTask = async (clientId, clientName, taskName, taskDescription, serviceId, assignedMembers = [], dueDate = null, createdBy, priority = TASK_PRIORITY.MEDIUM) => {
    try {
        await validateMembersExist(assignedMembers);
        await validateServiceForClient(clientId, serviceId);

        const tasksRef = ref(db, "tasks");
        const newTaskRef = push(tasksRef);
        await set(newTaskRef, {
            clientId,
            clientName,
            taskName,
            taskDescription,
            serviceId,
            assignedMembers,
            dueDate,
            createdBy,
            priority,
            status: TASK_STATUS.PENDING,
            createdAt: serverTimestamp(),
        });

        return {
            id: newTaskRef.key,
            clientId,
            clientName,
            taskName,
            taskDescription,
            serviceId,
            assignedMembers,
            dueDate,
            createdBy,
            priority,
            status: TASK_STATUS.PENDING,
            revisions: [],
        };
    } catch (error) {
        console.error("Error adding task:", error);
        throw error;
    }
};

//Delete a task by its ID
export const deleteTask = async (taskId) => {
    try {
        const taskRef = ref(db, `tasks/${taskId}`);
        const taskSnapshot = await get(taskRef);

        if (!taskSnapshot.exists()) {
            throw new Error("Task not found");
        }

        await remove(taskRef);
        return { id: taskId, ...taskSnapshot.val(), revisions: mapRevisions(taskSnapshot.val().revisions) };
    } catch (error) {
        console.error("Error deleting task:", error);
        throw error;
    }
};

//Edit a task's details (not its status/review data) by its ID
export const editTask = async (taskId, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, priority } = {}) => {
    try {
        const taskRef = ref(db, `tasks/${taskId}`);
        const taskSnapshot = await get(taskRef);

        if (!taskSnapshot.exists()) {
            throw new Error("Task not found");
        }

        const task = taskSnapshot.val();

        if (assignedMembers !== undefined) {
            await validateMembersExist(assignedMembers);
        }

        if (clientId !== undefined || serviceId !== undefined) {
            await validateServiceForClient(
                clientId !== undefined ? clientId : task.clientId,
                serviceId !== undefined ? serviceId : task.serviceId
            );
        }

        const updatedTaskData = {
            ...(clientId !== undefined && { clientId }),
            ...(clientName !== undefined && { clientName }),
            ...(taskName !== undefined && { taskName }),
            ...(taskDescription !== undefined && { taskDescription }),
            ...(serviceId !== undefined && { serviceId }),
            ...(assignedMembers !== undefined && { assignedMembers }),
            ...(dueDate !== undefined && { dueDate }),
            ...(priority !== undefined && { priority }),
        };

        const finalData = { ...task, ...updatedTaskData };
        await set(taskRef, finalData);

        return { id: taskId, ...finalData, revisions: mapRevisions(finalData.revisions) };
    } catch (error) {
        console.error("Error editing task:", error);
        throw error;
    }
};

//A member submits (or resubmits, after a revision request) their work on a task
export const submitTask = async (taskId, memberUuid, link, note = null) => {
    try {
        const taskRef = ref(db, `tasks/${taskId}`);
        const taskSnapshot = await get(taskRef);

        if (!taskSnapshot.exists()) {
            throw new Error("Task not found");
        }

        const task = taskSnapshot.val();

        if (!(task.assignedMembers ?? []).includes(memberUuid)) {
            throw new Error("This member is not assigned to this task");
        }

        if (task.status === TASK_STATUS.SUBMITTED || task.status === TASK_STATUS.COMPLETED) {
            throw new Error(`Task cannot be submitted while status is ${task.status}`);
        }

        await update(taskRef, {
            status: TASK_STATUS.SUBMITTED,
            submission: {
                link,
                note,
                submittedBy: memberUuid,
                submittedAt: serverTimestamp(),
            },
        });

        return {
            id: taskId,
            ...task,
            status: TASK_STATUS.SUBMITTED,
            revisions: mapRevisions(task.revisions),
            submission: { link, note, submittedBy: memberUuid, submittedAt: null },
        };
    } catch (error) {
        console.error("Error submitting task:", error);
        throw error;
    }
};

//A user reviews a submitted task, leaving a comment and deciding the next status
export const reviewTask = async (taskId, reviewedBy, comment, decision) => {
    try {
        if (decision !== TASK_STATUS.FOR_REVISION && decision !== TASK_STATUS.COMPLETED) {
            throw new Error('Decision must be "FOR_REVISION" or "COMPLETED"');
        }

        const taskRef = ref(db, `tasks/${taskId}`);
        const taskSnapshot = await get(taskRef);

        if (!taskSnapshot.exists()) {
            throw new Error("Task not found");
        }

        const task = taskSnapshot.val();

        if (task.status !== TASK_STATUS.SUBMITTED) {
            throw new Error("Only a submitted task can be reviewed");
        }

        const revisionsRef = ref(db, `tasks/${taskId}/revisions`);
        const newRevisionRef = push(revisionsRef);
        await set(newRevisionRef, {
            comment,
            status: decision,
            reviewedBy,
            reviewedAt: serverTimestamp(),
        });
        await update(taskRef, { status: decision });

        return {
            id: taskId,
            ...task,
            status: decision,
            revisions: [
                ...mapRevisions(task.revisions),
                { id: newRevisionRef.key, comment, status: decision, reviewedBy, reviewedAt: null },
            ],
        };
    } catch (error) {
        console.error("Error reviewing task:", error);
        throw error;
    }
};
