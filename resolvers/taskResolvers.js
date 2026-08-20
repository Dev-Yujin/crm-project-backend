import {
    getAllTasks,
    getTasksForMember,
    addTask,
    deleteTask,
    editTask,
    submitTask,
    reviewTask,
} from '../models/task.js';
import { requireUser, requireGroup, requireMember, requireCallerGroupId } from '../utils/requireUser.js';

const mapSubmission = (submission) => submission && {
    link: submission.link,
    note: submission.note ?? null,
    submittedBy: submission.submittedBy,
    submittedAt: submission.submittedAt != null ? String(submission.submittedAt) : null,
};

const mapRevision = (revision) => ({
    id: revision.id,
    comment: revision.comment,
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
    assignedUsers: task.assignedUsers ?? [],
    dueDate: task.dueDate ?? null,
    createdBy: task.createdBy ?? null,
    priority: task.priority,
    statusId: task.statusId ?? null,
    departmentId: task.departmentId ?? null,
    groupId: task.groupId,
    liveLink: task.liveLink ?? null,
    source: task.source ?? null,
    createdAt: task.createdAt != null ? String(task.createdAt) : null,
    submission: mapSubmission(task.submission),
    revisions: (task.revisions ?? []).map(mapRevision),
    recurringTaskId: task.recurringTaskId ?? null,
};

const taskResolvers = {
    Query: {
        tasks: async (_, __, context) => {
            const groupId = requireGroup(context);
            const tasks = await getAllTasks(groupId);
            return tasks.map(mapTask);
        },
        // memberUuid arg is accepted for backward compatibility but ignored — identity comes
        // from the caller's own verified member token, never from client input. See
        // SECURITY_BACKEND_ACTION_PLAN.md #2.
        tasksForMember: async (_, __, context) => {
            const member = requireMember(context);
            const tasks = await getTasksForMember(member.uuid);
            return tasks.map(mapTask);
        },
    },
    Mutation: {
        addTask: async (_, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, priority, statusId, departmentId, liveLink, source, assignedUsers }, context) => {
            const user = requireUser(context);
            const groupId = requireGroup(context);
            const task = await addTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, user.id, priority, null, statusId, departmentId, groupId, liveLink, source, assignedUsers);
            return mapTask(task);
        },
        // Called by both actor types: a user editing any task in their group (clientId,
        // assignedMembers, departmentId, ...) and a member updating their own assigned task.
        // Either auth works; scoped to the caller's own group either way.
        editTask: async (_, { taskId, ...updates }, context) => {
            const callerGroupId = requireCallerGroupId(context);
            const task = await editTask(taskId, updates, callerGroupId);
            return mapTask(task);
        },
        deleteTask: async (_, { taskId }, context) => {
            const groupId = requireGroup(context);
            const task = await deleteTask(taskId, groupId);
            return mapTask(task);
        },
        // Called by both actor types: a user (admin) recording a submission on behalf of
        // one of the task's assignees — memberUuid arg is required and meaningful here —
        // or a member submitting their OWN work, where memberUuid is ignored and identity
        // comes from their token instead. Either way the model checks the caller is among
        // the task's assignedMembers and that the task belongs to the caller's own group.
        submitTask: async (_, { taskId, memberUuid, link, note }, context) => {
            if (context?.user) {
                const groupId = requireGroup(context);
                const task = await submitTask(taskId, memberUuid, link, note, groupId);
                return mapTask(task);
            }
            const member = requireMember(context);
            const task = await submitTask(taskId, member.uuid, link, note, member.group_id);
            return mapTask(task);
        },
        reviewTask: async (_, { taskId, comment }, context) => {
            const user = requireUser(context);
            const groupId = requireGroup(context);
            const task = await reviewTask(taskId, user.id, comment, groupId);
            return mapTask(task);
        },
    },
};

export default taskResolvers;
