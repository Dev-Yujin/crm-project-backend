// One-time migration: for any task that has a `submission` but no `liveLink`,
// copies submission.link -> liveLink and submission.note -> notes, then removes
// the `submission` node from that task.
//
// Usage:
//   node scripts/backfill-submission-to-livelink.js            (dry run — prints planned changes only)
//   node scripts/backfill-submission-to-livelink.js --apply    (writes the changes)
//
// Run the dry run first, review the printed list, take a Firebase backup, then
// run with --apply.

import { getDatabase, ref, get, update } from "firebase/database";
import { app } from "../config/firebase.js";

const db = getDatabase(app);
const apply = process.argv.includes("--apply");

async function main() {
    const snapshot = await get(ref(db, "tasks"));
    const tasks = snapshot.val() ?? {};

    const candidates = Object.entries(tasks).filter(
        ([, task]) => task.submission && !task.liveLink,
    );

    if (candidates.length === 0) {
        console.log("No tasks need migrating — every task with a submission already has a liveLink.");
        return;
    }

    console.log(`${candidates.length} task(s) will be migrated:`);
    for (const [id, task] of candidates) {
        console.log(
            `  ${id} (${task.taskName ?? "untitled"}): liveLink <- "${task.submission.link}", notes <- ${JSON.stringify(task.submission.note ?? null)}`,
        );
    }

    if (!apply) {
        console.log("\nDry run only — no changes written. Re-run with --apply to write these changes.");
        return;
    }

    for (const [id, task] of candidates) {
        await update(ref(db, `tasks/${id}`), {
            liveLink: task.submission.link,
            notes: task.submission.note ?? null,
            submission: null,
        });
    }
    console.log(`\nDone — migrated ${candidates.length} task(s).`);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
