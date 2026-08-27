// One-time migration: for any task that has a `submission` but no `liveLink`,
// copies submission.link -> liveLink (after validating it the same way the app does)
// and submission.note -> notes, then removes the `submission` node from that task.
//
// Tasks that already have BOTH a `submission` and a `liveLink` are handled too: their
// existing `liveLink` is left untouched, but `submission.note` is still copied to `notes`
// and the stale `submission` node is still cleared, so no data is silently dropped.
//
// If a task's `submission.link` fails the app's own liveLink validation (see
// normalizeLiveLink in models/task.js — same http(s)-only rule used to guard against
// XSS via javascript:/data: URLs on the rendered anchor), that task's liveLink write is
// skipped and its `submission` node is left in place (not cleared) so the invalid value
// isn't lost and the task keeps showing up in future dry runs until someone fixes it
// manually. Its `notes` are still migrated independently, since that part has no conflict.
//
// Usage:
//   node scripts/backfill-submission-to-livelink.js            (dry run — prints planned changes only)
//   node scripts/backfill-submission-to-livelink.js --apply    (writes the changes)
//
// Run the dry run first, review the printed list, take a Firebase backup, then
// run with --apply.

import { getDatabase } from "firebase-admin/database";
import { app } from "../config/firebase.js";
import { normalizeLiveLink } from "../models/task.js";

const db = getDatabase(app);
const apply = process.argv.includes("--apply");

// Attempts to validate+normalize a submission's raw link the same way the app does.
// Returns { ok: true, value } on success, or { ok: false, reason } when there's nothing
// usable to write (empty/missing link, or a link normalizeLiveLink rejects outright).
function tryNormalizeSubmissionLink(rawLink) {
    if (rawLink == null) {
        return { ok: false, reason: "submission.link is missing" };
    }
    try {
        const normalized = normalizeLiveLink(rawLink);
        if (normalized == null) {
            return { ok: false, reason: `submission.link is empty (raw value: ${JSON.stringify(rawLink)})` };
        }
        return { ok: true, value: normalized };
    } catch (err) {
        return { ok: false, reason: `${err.message} (raw value: ${JSON.stringify(rawLink)})` };
    }
}

async function main() {
    const dbUrl = process.env.FIREBASE_DATABASE_URL;
    console.log(`Target database: ${dbUrl ?? "(FIREBASE_DATABASE_URL is not set!)"}`);

    const snapshot = await db.ref("tasks").once("value");
    const tasks = snapshot.val() ?? {};

    const needsLiveLink = [];
    const alreadyHasLiveLink = [];

    for (const entry of Object.entries(tasks)) {
        const [, task] = entry;
        if (!task.submission) continue;
        if (task.liveLink) {
            alreadyHasLiveLink.push(entry);
        } else {
            needsLiveLink.push(entry);
        }
    }

    if (needsLiveLink.length === 0 && alreadyHasLiveLink.length === 0) {
        console.log("No tasks need migrating — no task has a submission that still needs migrating.");
        return;
    }

    // Precompute link validation for the "needs liveLink" category so dry run and apply
    // print/act on identical results.
    const plannedLiveLink = needsLiveLink.map(([id, task]) => {
        const linkResult = tryNormalizeSubmissionLink(task.submission.link);
        return { id, task, linkResult };
    });

    if (plannedLiveLink.length > 0) {
        console.log(`\n${plannedLiveLink.length} task(s) missing a liveLink will be migrated:`);
        for (const { id, task, linkResult } of plannedLiveLink) {
            const notesValue = task.submission.note ?? null;
            if (linkResult.ok) {
                console.log(
                    `  ${id} (${task.taskName ?? "untitled"}): liveLink <- "${linkResult.value}", notes <- ${JSON.stringify(notesValue)}`,
                );
            } else {
                console.log(
                    `  ${id} (${task.taskName ?? "untitled"}): WARNING — liveLink SKIPPED (${linkResult.reason}); submission left in place for manual review. notes <- ${JSON.stringify(notesValue)} (still migrated)`,
                );
            }
        }
    }

    if (alreadyHasLiveLink.length > 0) {
        console.log(`\n${alreadyHasLiveLink.length} task(s) already have a liveLink — only notes will be migrated for these:`);
        for (const [id, task] of alreadyHasLiveLink) {
            const notesValue = task.submission.note ?? null;
            if (notesValue != null) {
                console.log(
                    `  ${id} (${task.taskName ?? "untitled"}): notes <- ${JSON.stringify(notesValue)} (liveLink untouched: "${task.liveLink}")`,
                );
            } else {
                console.log(
                    `  ${id} (${task.taskName ?? "untitled"}): no note to migrate; submission will just be cleared (liveLink untouched: "${task.liveLink}")`,
                );
            }
        }
    }

    if (!apply) {
        console.log("\nDry run only — no changes written. Re-run with --apply to write these changes.");
        return;
    }

    let migratedCount = 0;
    let skippedLinkCount = 0;
    for (const { id, task, linkResult } of plannedLiveLink) {
        const notesValue = task.submission.note ?? null;
        if (linkResult.ok) {
            await db.ref(`tasks/${id}`).update({
                liveLink: linkResult.value,
                notes: notesValue,
                submission: null,
            });
            migratedCount++;
        } else {
            console.warn(`Skipping liveLink write for task ${id} (${task.taskName ?? "untitled"}): ${linkResult.reason}`);
            await db.ref(`tasks/${id}`).update({
                notes: notesValue,
            });
            skippedLinkCount++;
        }
    }

    let notesOnlyCount = 0;
    for (const [id, task] of alreadyHasLiveLink) {
        const notesValue = task.submission.note ?? null;
        const updates = { submission: null };
        if (notesValue != null) {
            updates.notes = notesValue;
        }
        await db.ref(`tasks/${id}`).update(updates);
        notesOnlyCount++;
    }

    console.log(
        `\nDone — fully migrated ${migratedCount} task(s) (liveLink + notes), skipped liveLink on ${skippedLinkCount} task(s) with an invalid/empty link (notes migrated, submission left in place), and cleaned up ${notesOnlyCount} task(s) that already had a liveLink.`,
    );
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error("Migration failed:", err);
        process.exit(1);
    });
