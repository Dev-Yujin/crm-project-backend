import {
    getAllTasks,
    getTasksForMember,
    addTask,
    deleteTask,
    editTask,
    submitTask,
    reviewTask,
} from '../models/task.js';
import { requireUser } from '../utils/requireUser.js';

const mapSubmission = (submission) => submission && {
    link: submission.link,
    note: submission.note ?? null,
    submittedBy: submission.submittedBy,
    submittedAt: submission.submittedAt != null ? String(submission.submittedAt) : null,
};

const mapRevision = (revision) => ({
    id: revision.id,
    comment: revision.comment,
    status: revision.status,
    reviewedBy: revision.reviewedBy,
    reviewedAt: revision.reviewedAt != null ? String(revision.reviewedAt) : null,
});

const mapTask = (task) => task && {
    id: task.id,
    clientId: task.clientId,
    clientName: task.clientName,
    taskName: task.taskName,
    taskDescription: task.taskDescription,
    serviceId: task.serviceId,
    assignedMembers: task.assignedMembers ?? [],
    dueDate: task.dueDate ?? null,
    createdBy: task.createdBy ?? null,
    priority: task.priority,
    status: task.status,
    createdAt: task.createdAt != null ? String(task.createdAt) : null,
    submission: mapSubmission(task.submission),
    revisions: (task.revisions ?? []).map(mapRevision),
};

const taskResolvers = {
    Query: {
        tasks: async () => {
            const tasks = await getAllTasks();
            return tasks.map(mapTask);
        },
        tasksForMember: async (_, { memberUuid }) => {
            const tasks = await getTasksForMember(memberUuid);
            return tasks.map(mapTask);
        },
    },
    Mutation: {
        addTask: async (_, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, priority }, context) => {
            const user = requireUser(context);
            const task = await addTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, user.id, priority);
            return mapTask(task);
        },
        editTask: async (_, { taskId, ...updates }) => {
            const task = await editTask(taskId, updates);
            return mapTask(task);
        },
        deleteTask: async (_, { taskId }, context) => {
            requireUser(context);
            const task = await deleteTask(taskId);
            return mapTask(task);
        },
        // Member action: no bearer auth (members have no login mechanism yet),
        // memberUuid is self-declared and checked against the task's assignedMembers
        submitTask: async (_, { taskId, memberUuid, link, note }) => {
            const task = await submitTask(taskId, memberUuid, link, note);
            return mapTask(task);
        },
        reviewTask: async (_, { taskId, comment, decision }, context) => {
            const user = requireUser(context);
            const task = await reviewTask(taskId, user.id, comment, decision);
            return mapTask(task);
        },
    },
};

export default taskResolvers;
