import { getDatabase } from 'firebase-admin/database';
import { app } from '../config/firebase.js';
import { mapRevisions } from './task.js';
import { MAX_ATTACHMENTS_PER_TASK, LEGACY_ATTACHMENT_ID } from '../utils/attachments.js';

const db = getDatabase(app);

// Fetches a task and verifies it belongs to the caller's group — same existence/
// ownership check every task-mutating function in models/task.js already performs
// inline. Kept here as its own helper since every attachment operation needs it.
//
// revisions is mapped through mapRevisions here for the same reason every other
// task-returning function in models/task.js does it: Firebase stores it as an
// object keyed by push IDs, not a real array, and resolvers/taskResolvers.js's
// mapTask unconditionally calls .map() on it.
export async function getTaskForGroup(taskId, groupId) {
    const taskRef = db.ref(`tasks/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
        throw new Error('Task not found');
    }

    const data = snapshot.val();
    return { ref: taskRef, task: { id: taskId, ...data, revisions: mapRevisions(data.revisions) } };
}

// Moves a pre-multi-attachment task's single `attachment` into the `attachments`
// map under LEGACY_ATTACHMENT_ID. Idempotent — safe if two calls race.
async function migrateLegacyAttachment(ref, task) {
    if (task.attachment && task.attachment.key) {
        await ref.update({ [`attachments/${LEGACY_ATTACHMENT_ID}`]: task.attachment, attachment: null });
    }
}

// Appends one attachment to a task. The count limit is enforced inside an RTDB
// transaction so several files confirmed in parallel can never push a task past
// MAX_ATTACHMENTS_PER_TASK. Returns the updated task, or throws with
// code 'ATTACHMENT_LIMIT' when the task is already full.
export async function addTaskAttachment(taskId, groupId, attachment) {
    const { ref, task } = await getTaskForGroup(taskId, groupId);
    await migrateLegacyAttachment(ref, task);

    const attachmentId = ref.child('attachments').push().key;
    const result = await ref.child('attachments').transaction((current) => {
        const map = current ?? {};
        if (Object.keys(map).length >= MAX_ATTACHMENTS_PER_TASK) return undefined; // abort
        return { ...map, [attachmentId]: attachment };
    });

    if (!result.committed) {
        const err = new Error(`This task already has the maximum of ${MAX_ATTACHMENTS_PER_TASK} attachments.`);
        err.code = 'ATTACHMENT_LIMIT';
        throw err;
    }

    return (await getTaskForGroup(taskId, groupId)).task;
}

// Removes one attachment by id (including the un-migrated legacy one) and
// returns the updated task.
export async function removeTaskAttachmentById(taskId, groupId, attachmentId) {
    const { ref, task } = await getTaskForGroup(taskId, groupId);
    if (attachmentId === LEGACY_ATTACHMENT_ID && task.attachment) {
        await ref.update({ attachment: null });
    }
    await ref.child(`attachments/${attachmentId}`).remove();
    return (await getTaskForGroup(taskId, groupId)).task;
}
