import { getDatabase } from 'firebase-admin/database';
import { app } from '../config/firebase.js';
import { mapRevisions } from './task.js';

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

// Writes (or clears, if attachment is null) the attachment field on a task, returning
// the full updated task object in the same shape models/task.js's functions return
// (revisions already mapped to an array by getTaskForGroup above).
export async function setTaskAttachment(taskId, groupId, attachment) {
    const { ref, task } = await getTaskForGroup(taskId, groupId);
    const updated = { ...task, attachment };
    delete updated.id;
    await ref.update({ attachment });
    return { id: taskId, ...updated };
}
