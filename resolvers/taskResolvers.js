import {
    getAllTasks,
    getAllTasksForGroupIndexed,
    getTasksForMember,
    addTask,
    deleteTask,
    editTask,
    submitTask,
    reviewTask,
} from '../models/task.js';
import { requireUser, requireGroup, requireMember, requireCallerGroupId } from '../utils/requireUser.js';
import {
    validateContentType,
    validateFileSize,
    checkStorageQuota,
    validateAttachmentKey,
    validateAttachmentId,
    checkAttachmentCount,
    normalizeAttachments,
} from '../utils/attachments.js';
import { createUploadUrl, createDownloadUrl, deleteR2Object, headR2ObjectSize } from '../config/r2.js';
import { getOrCreateStorageUsage, adjustBytesUsed } from '../models/storage.js';
import { getOrCreateBilling } from '../models/billing.js';
import { getTaskForGroup, addTaskAttachment, removeTaskAttachmentById } from '../models/taskAttachments.js';
import { randomUUID } from 'crypto';
import { GraphQLError } from 'graphql';
import { fromStoredCustomFields } from '../models/customFields.js';

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

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const SPREADSHEET_TYPES = new Set([
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const mapAttachment = (attachment) => attachment && {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    uploadedBy: attachment.uploadedBy,
    uploadedAt: attachment.uploadedAt,
};

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
    notes: task.notes ?? null,
    // `attachment` (first file) is kept for older clients; `attachments` is the full list.
    attachments: normalizeAttachments(task).map(mapAttachment),
    attachment: mapAttachment(normalizeAttachments(task)[0] ?? null),
    createdAt: task.createdAt != null ? String(task.createdAt) : null,
    submission: mapSubmission(task.submission),
    revisions: (task.revisions ?? []).map(mapRevision),
    recurringTaskId: task.recurringTaskId ?? null,
    customFields: fromStoredCustomFields(task.customFields),
};

// Shared by requestTaskUploadUrl and requestTaskUploadUrls.
async function requestUploadTargets(taskId, files, context) {
    const groupId = requireCallerGroupId(context);

    if (!Array.isArray(files) || files.length === 0) {
        throw new GraphQLError('Select at least one file to upload.', { extensions: { code: 'BAD_USER_INPUT' } });
    }

    const { task } = await getTaskForGroup(taskId, groupId);

    try {
        checkAttachmentCount(normalizeAttachments(task).length, files.length);
    } catch (err) {
        throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
    }

    for (const file of files) {
        validateContentType(file.contentType);
        validateFileSize(file.sizeBytes);
    }

    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const [bytesUsed, billing] = await Promise.all([
        getOrCreateStorageUsage(groupId),
        getOrCreateBilling(groupId),
    ]);
    checkStorageQuota(bytesUsed, totalBytes, billing.limits.storageGb);

    return Promise.all(files.map(async ({ filename, contentType }) => {
        const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const key = `${groupId}/${taskId}/${randomUUID()}-${safeFilename}`;
        const uploadUrl = await createUploadUrl(key, contentType);
        return { uploadUrl, key };
    }));
}

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
        // attachmentId is optional for backward compatibility — omitted, it means the first file.
        taskAttachmentUrl: async (_, { taskId, attachmentId }, context) => {
            const groupId = requireCallerGroupId(context);
            const { task } = await getTaskForGroup(taskId, groupId);
            const attachments = normalizeAttachments(task);
            const attachment = attachmentId
                ? attachments.find((a) => a.id === attachmentId)
                : attachments[0];

            if (!attachment) {
                return null;
            }

            return createDownloadUrl(attachment.key);
        },
        taskStorageBreakdown: async (_, __, context) => {
            const groupId = requireCallerGroupId(context);
            const tasks = await getAllTasksForGroupIndexed(groupId);

            let imagesBytes = 0;
            let pdfBytes = 0;
            let spreadsheetsBytes = 0;

            for (const attachment of tasks.flatMap(normalizeAttachments)) {

                const sizeBytes = Number(attachment.sizeBytes);
                if (!Number.isFinite(sizeBytes)) continue;

                if (IMAGE_TYPES.has(attachment.contentType)) {
                    imagesBytes += sizeBytes;
                } else if (attachment.contentType === 'application/pdf') {
                    pdfBytes += sizeBytes;
                } else if (SPREADSHEET_TYPES.has(attachment.contentType)) {
                    spreadsheetsBytes += sizeBytes;
                }
            }

            return { imagesBytes, pdfBytes, spreadsheetsBytes };
        },
    },
    Mutation: {
        addTask: async (_, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, priority, statusId, departmentId, liveLink, source, assignedUsers, notes, customFields }, context) => {
            const user = requireUser(context);
            const groupId = requireGroup(context);
            const task = await addTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, user.id, priority, null, statusId, departmentId, groupId, liveLink, source, assignedUsers, notes, customFields);
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
        requestTaskUploadUrl: async (_, { taskId, filename, contentType, sizeBytes }, context) => {
            const [target] = await requestUploadTargets(taskId, [{ filename, contentType, sizeBytes }], context);
            return target;
        },
        // Batch version for multi-file uploads: validates the whole selection up
        // front (count limit + combined storage quota) and returns one presigned
        // URL per file, in the same order as `files`.
        requestTaskUploadUrls: async (_, { taskId, files }, context) => {
            return requestUploadTargets(taskId, files, context);
        },
        confirmTaskAttachment: async (_, { taskId, key, filename, contentType, sizeBytes }, context) => {
            const groupId = requireCallerGroupId(context);
            const uploadedBy = context?.user ? `admin:${context.user.id}` : `member:${context.member.uuid}`;

            try {
                validateAttachmentKey(key, groupId, taskId);
            } catch (err) {
                throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
            }

            validateContentType(contentType);
            validateFileSize(sizeBytes);

            let actualSizeBytes;
            try {
                actualSizeBytes = await headR2ObjectSize(key);
                validateFileSize(actualSizeBytes);
            } catch (err) {
                throw new GraphQLError('The uploaded file could not be verified — try uploading again.', {
                    extensions: { code: 'UPLOAD_NOT_FOUND' },
                });
            }

            const attachment = {
                key,
                filename,
                contentType,
                sizeBytes: actualSizeBytes,
                uploadedBy,
                uploadedAt: new Date().toISOString(),
            };

            let updated;
            try {
                updated = await addTaskAttachment(taskId, groupId, attachment);
            } catch (err) {
                if (err.code === 'ATTACHMENT_LIMIT') {
                    // The bytes are already in R2 but will never be referenced — clean up.
                    await deleteR2Object(key).catch(() => {});
                    throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
                }
                throw err;
            }
            await adjustBytesUsed(groupId, actualSizeBytes);

            return mapTask(updated);
        },
        // attachmentId is optional for backward compatibility — omitted, it removes the first file.
        removeTaskAttachment: async (_, { taskId, attachmentId }, context) => {
            const groupId = requireCallerGroupId(context);
            const callerIdentity = context?.user ? `admin:${context.user.id}` : `member:${context.member.uuid}`;
            const isAdmin = !!context?.user;

            const { task: existing } = await getTaskForGroup(taskId, groupId);
            if (attachmentId) {
                try {
                    validateAttachmentId(attachmentId);
                } catch (err) {
                    throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
                }
            }
            const attachments = normalizeAttachments(existing);
            const attachment = attachmentId
                ? attachments.find((a) => a.id === attachmentId)
                : attachments[0];

            if (!attachment) {
                return mapTask(existing);
            }

            if (!isAdmin && attachment.uploadedBy !== callerIdentity) {
                throw new GraphQLError('Only the uploader or an admin can remove this attachment.', {
                    extensions: { code: 'FORBIDDEN' },
                });
            }

            const updated = await removeTaskAttachmentById(taskId, groupId, attachment.id);
            await adjustBytesUsed(groupId, -attachment.sizeBytes);
            await deleteR2Object(attachment.key);

            return mapTask(updated);
        },
    },
};

export default taskResolvers;
