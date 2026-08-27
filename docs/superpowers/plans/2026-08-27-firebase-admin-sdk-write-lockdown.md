# Firebase Admin SDK Write Lockdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the backend from the anonymous `firebase` client SDK to `firebase-admin` (a trusted service-account credential that bypasses RTDB rules), so Firebase Realtime Database writes can be locked to the backend only.

**Architecture:** `config/firebase.js` is rewritten to initialize `firebase-admin` with a service-account credential loaded from an environment variable. Every other file that touches Firebase RTDB (7 model files + 1 migration script) is converted from the client SDK's modular function-call API (`get(ref(db, path))`, `set(ref, data)`, etc.) to the Admin SDK's method-call API (`db.ref(path).once("value")`, `ref.set(data)`, etc.) — these are genuinely different call shapes, not just import renames. Rollout is staged: ship the migration with RTDB rules left exactly as they are today, verify the backend still writes correctly, then flip `.write: false` in the Firebase Console as a separate final step.

**Tech Stack:** Node.js (ESM), Express, Apollo Server, `firebase-admin` (new dependency), Firebase Realtime Database.

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-27-firebase-admin-sdk-write-lockdown-design.md`.
- **No automated test runner exists in this repo** (`npm test` is a stub that always fails). Every task's verification is `node --check <file>` (syntax) plus a real, manual exercise of the affected function(s) against the actual dev Firebase database — same pattern established in this repo's prior migration-script work.
- **Never print, log, or write the service account key's contents anywhere** — not to a committed file, not to console output, not into this plan. Task 1's step that adds it to `.env` reads the file and appends it programmatically; it is never displayed.
- The `firebase` (client SDK) package stays in `package.json` — do not remove it. Confirming nothing else in the repo still needs it is out of scope for this plan.
- Function signatures and return shapes of every converted function stay identical — only *how* each function talks to Firebase changes, never *what* it returns or *what arguments it takes*. Every caller of these functions (resolvers, other models) needs zero changes.
- Read access (`.read: true`) is explicitly left open by this plan — do not tighten it. Read-side scoping is a separate, future plan.

---

## Task 1: Add `firebase-admin`, load the service account credential, rewrite `config/firebase.js`

**Files:**
- Modify: `/Users/eugenelinsangan/crm-proj/package.json` (via `npm install`, not hand-edited)
- Modify: `/Users/eugenelinsangan/crm-proj/.env` (append one line, via script — never hand-type or display the secret)
- Modify: `/Users/eugenelinsangan/crm-proj/config/firebase.js`
- Test: `node --check` + manual verification (see Step 5)

**Interfaces:**
- Produces: `export const app` — now a `firebase-admin` App instance (was a client-SDK App instance before). Every model file's `import { app } from "../config/firebase.js"` keeps working unchanged; what changes is what each file *does* with `app` (Tasks 2-7).

- [ ] **Step 1: Install `firebase-admin`**

```bash
cd /Users/eugenelinsangan/crm-proj
npm install firebase-admin
```

Expected: `package.json` gains a `"firebase-admin"` entry under `dependencies`; `package-lock.json` updates.

- [ ] **Step 2: Load the service account key into `.env` without ever displaying it**

The key file is already in place (gitignored) at `config/crm-backend-df5ea-firebase-adminsdk-fbsvc-3393371583.json`. Run this exactly — it reads the file, collapses it to one line, and appends it to `.env` programmatically, so the secret never appears in your terminal output or anywhere else:

```bash
cd /Users/eugenelinsangan/crm-proj
node -e "
const fs = require('fs');
const raw = fs.readFileSync('config/crm-backend-df5ea-firebase-adminsdk-fbsvc-3393371583.json', 'utf8');
const oneLine = JSON.stringify(JSON.parse(raw));
fs.appendFileSync('.env', '\n#FIREBASE ADMIN SDK (service account credential — never commit)\nGOOGLE_APPLICATION_CREDENTIALS_JSON=' + oneLine + '\n');
console.log('Appended GOOGLE_APPLICATION_CREDENTIALS_JSON to .env (' + oneLine.length + ' chars)');
"
```

Expected output: `Appended GOOGLE_APPLICATION_CREDENTIALS_JSON to .env (<some number> chars)` — a length only, never the content. Confirm `.env` is still gitignored (`git check-ignore .env` should print `.env`) so this new line is never at risk of being committed.

- [ ] **Step 3: Rewrite `config/firebase.js`**

Replace the full file contents with:

```js
import admin from "firebase-admin";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!raw) {
  throw new Error(
    "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set — the backend cannot authenticate to Firebase without it. " +
    "Set it to the full contents of your Firebase service account key JSON (see docs/superpowers/specs/2026-08-27-firebase-admin-sdk-write-lockdown-design.md)."
  );
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch (err) {
  throw new Error(`GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${err.message}`);
}

// Initialize Firebase Admin SDK — a trusted service-account credential that
// bypasses RTDB security rules entirely, by design. This is what lets the
// backend keep writing once rules are tightened to .write: false for everyone
// else (see the design spec's rollout plan).
export const app = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
```

- [ ] **Step 4: Verify syntax**

```bash
node --check config/firebase.js
```

Expected: no output (success).

- [ ] **Step 5: Verify it actually connects**

```bash
node -e "
import('./config/firebase.js').then(async ({ app }) => {
  const admin = (await import('firebase-admin')).default;
  const snapshot = await admin.database(app).ref('taskStatuses').once('value');
  console.log('Connected via Admin SDK. Sample read returned', snapshot.exists() ? 'data' : 'no data', '— childCount:', snapshot.numChildren());
  process.exit(0);
}).catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
"
```

Expected: `Connected via Admin SDK. Sample read returned ... childCount: <N>` — proves the credential is valid and the Admin SDK can reach your actual database. If this throws, stop here — nothing downstream will work until this succeeds (check for a typo'd env var, a malformed JSON, or a `databaseURL` mismatch).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json config/firebase.js
git commit -m "Migrate config/firebase.js to Firebase Admin SDK"
```

(`.env` is gitignored — Step 2's addition is never staged, which is correct; do not `git add .env`.)

---

## Task 2: Migrate `models/task.js` to the Admin SDK

**Files:**
- Modify: `/Users/eugenelinsangan/crm-proj/models/task.js`
- Test: `node --check` + manual verification (see Step 3)

**Interfaces:**
- Consumes: `app` from Task 1 (a `firebase-admin` App).
- Produces: unchanged — every exported function (`validateMembersExist`, `validateServiceForClient`, `normalizeLiveLink`, `getAllTasks`, `getTasksForMember`, `addTask`, `deleteTask`, `editTask`, `submitTask`, `reviewTask`, `TASK_PRIORITY`) keeps its exact same name, parameters, and return shape. `recurringTasks.js` (Task 3) imports `validateMembersExist`, `validateServiceForClient`, `addTask`, `TASK_PRIORITY` from this file and needs zero changes to those call sites.

This is the API-shape translation used throughout this plan: the client SDK's modular functions (`get(ref(db, path))`, `set(ref, data)`, `update(ref, data)`, `remove(ref)`, `push(ref)`, `serverTimestamp()`) become Admin SDK method calls (`db.ref(path).once("value")`, `ref.set(data)`, `ref.update(data)`, `ref.remove()`, `ref.push()`, `admin.database.ServerValue.TIMESTAMP`). `snapshot.exists()` and `snapshot.val()` are unchanged in both SDKs.

- [ ] **Step 1: Replace the full file contents**

```js
import admin from "firebase-admin";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";
import { validateTaskStatusExists } from "./taskStatuses.js";
import { validateDepartmentExists } from "./departments.js";
import { fetchMemberGroupId } from "../utils/groups.js";
import { validateUsersExist } from "./groups.js";

const db = admin.database(app);

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

const mapRevisions = (revisions) =>
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
export const addTask = async (clientId, clientName, taskName, taskDescription, serviceId, assignedMembers = [], dueDate = null, createdBy, priority = TASK_PRIORITY.MEDIUM, recurringTaskId = null, statusId = null, departmentId = null, groupId, liveLink = null, source = null, assignedUsers = [], notes = null) => {
    try {
        await validateMembersExist(assignedMembers, groupId);
        await validateUsersExist(assignedUsers, groupId);
        await validateServiceForClient(clientId, serviceId, groupId);
        await validateTaskStatusExists(statusId, groupId);
        await validateDepartmentExists(departmentId, groupId);

        const normalizedLiveLink = liveLink != null ? normalizeLiveLink(liveLink) : null;
        const normalizedSource = source != null ? normalizeSource(source) : null;
        const normalizedNotes = notes != null ? normalizeNotes(notes) : null;
        const dedupedAssignedUsers = [...new Set(assignedUsers ?? [])];

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
            createdAt: admin.database.ServerValue.TIMESTAMP,
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
export const editTask = async (taskId, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, dueDate, priority, statusId, departmentId, liveLink, source, notes, assignedUsers } = {}, callerGroupId) => {
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
            submittedAt: admin.database.ServerValue.TIMESTAMP,
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
            reviewedAt: admin.database.ServerValue.TIMESTAMP,
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
```

- [ ] **Step 2: Verify syntax**

```bash
node --check models/task.js
```

- [ ] **Step 3: Verify against the real database**

Start the backend (`npm run dev`) and, authenticated as an admin (or via a script directly calling these functions the way Task 1's Step 5 did), exercise: `addTask` (confirm the returned object has a real `id` and `createdAt` becomes a real timestamp on read-back), `editTask` (confirm a field updates), `submitTask` (confirm `submission.submittedAt` becomes a real timestamp on read-back), `reviewTask` (confirm a revision is added), `deleteTask` (confirm it's gone). Since `RTDB rules are still open at this point` (Task 8 hasn't been deployed yet), these will succeed via the open rules AND via the Admin SDK identically — the real proof this task is correct comes in Task 9's Stage 1 verification pass, once every file is converted. For now, confirm no exceptions are thrown and returned/read-back data looks correct.

- [ ] **Step 4: Commit**

```bash
git add models/task.js
git commit -m "Migrate models/task.js to Firebase Admin SDK"
```

---

## Task 3: Migrate `models/recurringTasks.js` to the Admin SDK

**Files:**
- Modify: `/Users/eugenelinsangan/crm-proj/models/recurringTasks.js`
- Test: `node --check` + manual verification

**Interfaces:**
- Consumes: `app` from Task 1; `validateMembersExist`, `validateServiceForClient`, `addTask`, `TASK_PRIORITY` from `models/task.js` (Task 2) — these imports and call sites are untouched, since Task 2 kept their signatures identical.

- [ ] **Step 1: Replace the full file contents**

```js
import admin from "firebase-admin";
import { app } from "../config/firebase.js";
import {
    validateMembersExist,
    validateServiceForClient,
    addTask,
    TASK_PRIORITY,
} from "./task.js";
import { validateUsersExist } from "./groups.js";
import { validateDepartmentExists } from "./departments.js";
//Recurring task templates: on their schedule, the scheduler generates a fresh
//one-off Task instance (via addTask) tagged with recurringTaskId

const db = admin.database(app);

export const RECURRENCE = {
    DAILY: "DAILY",
    WEEKLY: "WEEKLY",
    MONTHLY: "MONTHLY",
};

const computeNextRun = (from, recurrence) => {
    const date = new Date(from);

    if (recurrence === RECURRENCE.DAILY) date.setDate(date.getDate() + 1);
    else if (recurrence === RECURRENCE.WEEKLY) date.setDate(date.getDate() + 7);
    else if (recurrence === RECURRENCE.MONTHLY) date.setMonth(date.getMonth() + 1);

    return date.getTime();
};

//Create a recurring task template and immediately generate its first task instance
export const addRecurringTask = async (clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, createdBy, recurrence, priority = TASK_PRIORITY.MEDIUM, groupId, assignedUsers = [], departmentId = null) => {
    try {
        await validateMembersExist(assignedMembers, groupId);
        await validateUsersExist(assignedUsers, groupId);
        await validateServiceForClient(clientId, serviceId, groupId);
        await validateDepartmentExists(departmentId, groupId);

        const dedupedAssignedUsers = [...new Set(assignedUsers ?? [])];

        const recurringTasksRef = db.ref("recurringTasks");
        const newTemplateRef = recurringTasksRef.push();
        const now = Date.now();

        const template = {
            clientId,
            clientName,
            taskName,
            taskDescription,
            serviceId,
            assignedMembers,
            assignedUsers: dedupedAssignedUsers,
            createdBy,
            priority,
            recurrence,
            departmentId,
            groupId,
            active: true,
            lastRunAt: now,
            nextRunAt: computeNextRun(now, recurrence),
        };

        await newTemplateRef.set(template);

        await addTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, null, createdBy, priority, newTemplateRef.key, null, departmentId, groupId, null, null, dedupedAssignedUsers);

        return { id: newTemplateRef.key, ...template };
    } catch (error) {
        console.error("Error adding recurring task:", error);
        throw error;
    }
};

//Fetch every recurring task template across all groups — used only by the scheduler's cron tick
const getAllRecurringTasksAcrossGroups = async () => {
    const snapshot = await db.ref("recurringTasks").once("value");
    const data = snapshot.val();
    return data ? Object.entries(data).map(([id, template]) => ({ id, ...template })) : [];
};

//Fetch all recurring task templates belonging to a group
export const getAllRecurringTasks = async (groupId) => {
    try {
        const templates = await getAllRecurringTasksAcrossGroups();
        return templates.filter((template) => template.groupId === groupId);
    } catch (error) {
        console.error("Error fetching recurring tasks:", error);
        throw error;
    }
};

//Delete a recurring task template (already-generated task instances are left untouched). Must belong to the caller's group.
export const deleteRecurringTask = async (recurringTaskId, groupId) => {
    try {
        const templateRef = db.ref(`recurringTasks/${recurringTaskId}`);
        const snapshot = await templateRef.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Recurring task not found");
        }

        await templateRef.remove();
        return true;
    } catch (error) {
        console.error("Error deleting recurring task:", error);
        throw error;
    }
};

const setActive = async (recurringTaskId, active, groupId) => {
    const templateRef = db.ref(`recurringTasks/${recurringTaskId}`);
    const snapshot = await templateRef.once("value");

    if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
        throw new Error("Recurring task not found");
    }

    await templateRef.update({ active });
    return { id: recurringTaskId, ...snapshot.val(), active };
};

//Pause a recurring task template — the scheduler skips it until resumed. Must belong to the caller's group.
export const pauseRecurringTask = async (recurringTaskId, groupId) => {
    try {
        return await setActive(recurringTaskId, false, groupId);
    } catch (error) {
        console.error("Error pausing recurring task:", error);
        throw error;
    }
};

//Resume a paused recurring task template. Must belong to the caller's group.
export const resumeRecurringTask = async (recurringTaskId, groupId) => {
    try {
        return await setActive(recurringTaskId, true, groupId);
    } catch (error) {
        console.error("Error resuming recurring task:", error);
        throw error;
    }
};

//Scheduler tick: generate one task instance for every active template that's due (across all groups),
//then advance nextRunAt (catching up past any missed cycles without spamming instances)
export const runDueRecurringTasks = async () => {
    const templates = await getAllRecurringTasksAcrossGroups();
    const now = Date.now();
    const generated = [];

    for (const template of templates) {
        if (!template.active || template.nextRunAt > now) continue;

        try {
            const task = await addTask(
                template.clientId,
                template.clientName,
                template.taskName,
                template.taskDescription,
                template.serviceId,
                template.assignedMembers,
                null,
                template.createdBy,
                template.priority,
                template.id,
                null,
                template.departmentId,
                template.groupId,
                null,
                null,
                template.assignedUsers
            );
            generated.push(task);

            let nextRunAt = computeNextRun(template.nextRunAt, template.recurrence);
            while (nextRunAt <= now) {
                nextRunAt = computeNextRun(nextRunAt, template.recurrence);
            }

            await db.ref(`recurringTasks/${template.id}`).update({
                lastRunAt: now,
                nextRunAt,
            });
        } catch (error) {
            console.error(`Error running recurring task ${template.id}:`, error);
        }
    }

    return generated;
};
```

- [ ] **Step 2: Verify syntax**

```bash
node --check models/recurringTasks.js
```

- [ ] **Step 3: Verify against the real database**

Exercise `addRecurringTask` (confirm both the template and its generated first task instance are created), `pauseRecurringTask`/`resumeRecurringTask` (confirm `active` toggles), `deleteRecurringTask`.

- [ ] **Step 4: Commit**

```bash
git add models/recurringTasks.js
git commit -m "Migrate models/recurringTasks.js to Firebase Admin SDK"
```

---

## Task 4: Migrate `models/services.js` and `models/taskStatuses.js` to the Admin SDK

**Files:**
- Modify: `/Users/eugenelinsangan/crm-proj/models/services.js`
- Modify: `/Users/eugenelinsangan/crm-proj/models/taskStatuses.js`
- Test: `node --check` + manual verification

**Interfaces:**
- Consumes: `app` from Task 1.
- Produces: unchanged — `models/task.js` (Task 2) already imports `validateTaskStatusExists` from `taskStatuses.js`; that call site needs no change.

These two files are structurally identical (a catalog CRUD pattern), so they're one task.

- [ ] **Step 1: Replace `models/services.js`'s full contents**

```js
import admin from "firebase-admin";
import { app } from "../config/firebase.js";
//The catalog of services the business offers (e.g. "Web Development", "Video Editing") — scoped per group

const db = admin.database(app);

//Fetch all services belonging to a group
export const getAllServices = async (groupId) => {
    try {
        const servicesSnapshot = await db.ref("services").once("value");
        const servicesData = servicesSnapshot.val();
        const services = servicesData ? Object.entries(servicesData).map(([id, service]) => ({ id, ...service })) : [];
        return services.filter((service) => service.groupId === groupId);
    } catch (error) {
        console.error("Error fetching services:", error);
        throw error;
    }
};

//Add a new service to a group's catalog
export const addService = async (name, groupId) => {
    try {
        const servicesRef = db.ref("services");
        const newServiceRef = servicesRef.push();
        await newServiceRef.set({ name, groupId });
        return { id: newServiceRef.key, name, groupId };
    } catch (error) {
        console.error("Error adding service:", error);
        throw error;
    }
};

//Update a service's name (must belong to the caller's group)
export const updateService = async (serviceId, name, groupId) => {
    try {
        const serviceRef = db.ref(`services/${serviceId}`);
        const serviceSnapshot = await serviceRef.once("value");

        if (!serviceSnapshot.exists() || serviceSnapshot.val().groupId !== groupId) {
            throw new Error("Service not found");
        }

        await serviceRef.update({ name });
        return { id: serviceId, name, groupId };
    } catch (error) {
        console.error("Error updating service:", error);
        throw error;
    }
};

//Delete a service (must belong to the caller's group)
export const deleteService = async (serviceId, groupId) => {
    try {
        const serviceRef = db.ref(`services/${serviceId}`);
        const serviceSnapshot = await serviceRef.once("value");

        if (!serviceSnapshot.exists() || serviceSnapshot.val().groupId !== groupId) {
            throw new Error("Service not found");
        }

        await serviceRef.remove();
        return { id: serviceId, ...serviceSnapshot.val() };
    } catch (error) {
        console.error("Error deleting service:", error);
        throw error;
    }
};

//Validate that every given service ID exists in the given group's catalog
export const validateServicesExist = async (serviceIds, groupId) => {
    if (!serviceIds || serviceIds.length === 0) {
        return;
    }

    const services = await getAllServices(groupId);
    const existingIds = new Set(services.map((service) => service.id));
    const missing = serviceIds.filter((id) => !existingIds.has(id));

    if (missing.length > 0) {
        throw new Error(`Service(s) not found: ${missing.join(", ")}`);
    }
};
```

- [ ] **Step 2: Replace `models/taskStatuses.js`'s full contents**

```js
import admin from "firebase-admin";
import { app } from "../config/firebase.js";
//A user-managed catalog of task statuses (e.g. "Pending", "On Going", "Submitted", "Completed") — scoped per group
//There is no fixed workflow — users define whatever statuses they want and set them freely on a task

const db = admin.database(app);

//Fetch all task statuses belonging to a group
export const getAllTaskStatuses = async (groupId) => {
    try {
        const snapshot = await db.ref("taskStatuses").once("value");
        const data = snapshot.val();
        const taskStatuses = data ? Object.entries(data).map(([id, taskStatus]) => ({ id, ...taskStatus })) : [];
        return taskStatuses.filter((taskStatus) => taskStatus.groupId === groupId);
    } catch (error) {
        console.error("Error fetching task statuses:", error);
        throw error;
    }
};

//Add a new task status to a group's catalog
export const addTaskStatus = async (name, groupId) => {
    try {
        const taskStatusesRef = db.ref("taskStatuses");
        const newTaskStatusRef = taskStatusesRef.push();
        await newTaskStatusRef.set({ name, groupId });
        return { id: newTaskStatusRef.key, name, groupId };
    } catch (error) {
        console.error("Error adding task status:", error);
        throw error;
    }
};

//Update a task status's name (must belong to the caller's group)
export const updateTaskStatus = async (taskStatusId, name, groupId) => {
    try {
        const taskStatusRef = db.ref(`taskStatuses/${taskStatusId}`);
        const snapshot = await taskStatusRef.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Task status not found");
        }

        await taskStatusRef.update({ name });
        return { id: taskStatusId, name, groupId };
    } catch (error) {
        console.error("Error updating task status:", error);
        throw error;
    }
};

//Delete a task status (must belong to the caller's group)
export const deleteTaskStatus = async (taskStatusId, groupId) => {
    try {
        const taskStatusRef = db.ref(`taskStatuses/${taskStatusId}`);
        const snapshot = await taskStatusRef.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Task status not found");
        }

        await taskStatusRef.remove();
        return { id: taskStatusId, ...snapshot.val() };
    } catch (error) {
        console.error("Error deleting task status:", error);
        throw error;
    }
};

//No-op if taskStatusId is null, otherwise throws if it's not in the caller's group's catalog
export const validateTaskStatusExists = async (taskStatusId, groupId) => {
    if (taskStatusId == null) {
        return;
    }

    const taskStatuses = await getAllTaskStatuses(groupId);
    const exists = taskStatuses.some((taskStatus) => taskStatus.id === taskStatusId);

    if (!exists) {
        throw new Error(`Task status not found: ${taskStatusId}`);
    }
};
```

- [ ] **Step 3: Verify syntax**

```bash
node --check models/services.js
node --check models/taskStatuses.js
```

- [ ] **Step 4: Verify against the real database**

Exercise `addService`/`updateService`/`deleteService` and `addTaskStatus`/`updateTaskStatus`/`deleteTaskStatus` — confirm each CRUD cycle works and `getAllServices`/`getAllTaskStatuses` reflect the changes.

- [ ] **Step 5: Commit**

```bash
git add models/services.js models/taskStatuses.js
git commit -m "Migrate models/services.js and models/taskStatuses.js to Firebase Admin SDK"
```

---

## Task 5: Migrate `models/departments.js` to the Admin SDK

**Files:**
- Modify: `/Users/eugenelinsangan/crm-proj/models/departments.js`
- Test: `node --check` + manual verification

**Interfaces:**
- Consumes: `app` from Task 1.
- Produces: unchanged — `models/task.js` (Task 2) imports `validateDepartmentExists` from this file; that call site needs no change.

- [ ] **Step 1: Replace the full file contents**

```js
import admin from "firebase-admin";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";
//Create a Department, and assign members (from the Postgres members table) to that Department — scoped per group

const db = admin.database(app);

const mapMembers = (members) =>
    Object.entries(members ?? {}).map(([uuid, member]) => ({
        uuid,
        username: member.username,
        email: member.email,
        assignedAt: member.assignedAt,
    }));

//Add department function
export const addDepartment = async (name, groupId) => {
    try {
        const departmentsRef = db.ref("departments");
        const newDepartmentRef = departmentsRef.push();
        await newDepartmentRef.set({
            name,
            groupId,
            createdAt: admin.database.ServerValue.TIMESTAMP,
        });

        return { id: newDepartmentRef.key, name, groupId };
    } catch (error) {
        console.error("Error adding department:", error);
        throw error;
    }
};

//Update a department's name (must belong to the caller's group)
export const updateDepartment = async (departmentId, name, groupId) => {
    try {
        const departmentRef = db.ref(`departments/${departmentId}`);
        const departmentSnapshot = await departmentRef.once("value");

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        await departmentRef.update({ name });
        return { id: departmentId, ...departmentSnapshot.val(), name, members: mapMembers(departmentSnapshot.val().members) };
    } catch (error) {
        console.error("Error updating department:", error);
        throw error;
    }
};

//Delete a department (must belong to the caller's group)
export const deleteDepartment = async (departmentId, groupId) => {
    try {
        const departmentRef = db.ref(`departments/${departmentId}`);
        const departmentSnapshot = await departmentRef.once("value");

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        await departmentRef.remove();
        return { id: departmentId, ...departmentSnapshot.val(), members: mapMembers(departmentSnapshot.val().members) };
    } catch (error) {
        console.error("Error deleting department:", error);
        throw error;
    }
};

//Add a member (by their members.uuid) to a department (both must belong to the caller's group)
export const addMemberToDepartment = async (departmentId, memberUuid, groupId) => {
    try {
        const departmentRef = db.ref(`departments/${departmentId}`);
        const departmentSnapshot = await departmentRef.once("value");

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        const memberQuery = "SELECT uuid, username, email FROM members WHERE uuid = $1 AND group_id = $2";
        const result = await pool.query(memberQuery, [memberUuid, groupId]);

        if (result.rows.length === 0) {
            throw new Error("Member not found");
        }

        const member = result.rows[0];
        const memberRef = db.ref(`departments/${departmentId}/members/${memberUuid}`);
        await memberRef.set({
            username: member.username,
            email: member.email,
            assignedAt: admin.database.ServerValue.TIMESTAMP,
        });

        return { departmentId, uuid: member.uuid, username: member.username, email: member.email };
    } catch (error) {
        console.error("Error adding member to department:", error);
        throw error;
    }
};

//Remove a member from a department (must belong to the caller's group)
export const removeMemberFromDepartment = async (departmentId, memberUuid, groupId) => {
    try {
        const departmentRef = db.ref(`departments/${departmentId}`);
        const departmentSnapshot = await departmentRef.once("value");

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        const memberRef = db.ref(`departments/${departmentId}/members/${memberUuid}`);
        const memberSnapshot = await memberRef.once("value");

        if (!memberSnapshot.exists()) {
            throw new Error("Member is not assigned to this department");
        }

        await memberRef.remove();
        return true;
    } catch (error) {
        console.error("Error removing member from department:", error);
        throw error;
    }
};

//Fetch all departments belonging to a group, along with their assigned members
export const getAllDepartments = async (groupId) => {
    try {
        const departmentsSnapshot = await db.ref("departments").once("value");

        if (!departmentsSnapshot.exists()) {
            return [];
        }

        return Object.entries(departmentsSnapshot.val())
            .filter(([, department]) => department.groupId === groupId)
            .map(([id, department]) => ({
                id,
                name: department.name,
                groupId: department.groupId,
                createdAt: department.createdAt,
                members: mapMembers(department.members),
            }));
    } catch (error) {
        console.error("Error fetching departments:", error);
        throw error;
    }
};

//No-op if departmentId is null, otherwise throws if it's not in the caller's group's departments catalog
export const validateDepartmentExists = async (departmentId, groupId) => {
    if (departmentId == null) return;

    const departmentSnapshot = await db.ref(`departments/${departmentId}`).once("value");

    if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
        throw new Error("Department not found");
    }
};
```

- [ ] **Step 2: Verify syntax**

```bash
node --check models/departments.js
```

- [ ] **Step 3: Verify against the real database**

Exercise `addDepartment` → `addMemberToDepartment` → confirm `getAllDepartments` shows the member → `removeMemberFromDepartment` → `deleteDepartment`.

- [ ] **Step 4: Commit**

```bash
git add models/departments.js
git commit -m "Migrate models/departments.js to Firebase Admin SDK"
```

---

## Task 6: Migrate `models/clients.js` to the Admin SDK

**Files:**
- Modify: `/Users/eugenelinsangan/crm-proj/models/clients.js`
- Test: `node --check` + manual verification

**Interfaces:**
- Consumes: `app` from Task 1.
- Produces: unchanged — `models/task.js` (Task 2) reads directly from the `clients/` path itself (not via a function this file exports), so nothing to update there.

This file's existing style calls `getDatabase(app)` inline at every call site (no top-level `const db`), unlike the other model files. Preserve that existing style choice exactly — don't introduce a top-level `db` variable here; that would be an unrelated style change outside this task's scope.

- [ ] **Step 1: Replace the full file contents**

```js
import admin from "firebase-admin";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";
import { validateServicesExist } from "./services.js";

//Fetch all clients belonging to a group
export const getAllClients = async (groupId) => {
    try {
        const clientsSnapshot = await admin.database(app).ref("clients").once("value");
        const clientsData = clientsSnapshot.val();
        const clients = clientsData ? Object.entries(clientsData).map(([id, client]) => ({ id, ...client })) : [];
        return clients.filter((client) => client.groupId === groupId);
    } catch (error) {
        console.error("Error fetching all clients:", error);
        throw error;
    }
};

//Add a new client to a group
export const addClient = async (clientName, businessName, email, whatsappNumber = null, clientNotes = null, servicesAvailed = null, groupId) => {
    try {
        await validateServicesExist(servicesAvailed, groupId);

        const clientsRef = admin.database(app).ref("clients");
        const newClientRef = clientsRef.push();
        await newClientRef.set({
            clientName,
            businessName,
            email,
            whatsappNumber,
            clientNotes,
            servicesAvailed,
            groupId,
            createdAt: admin.database.ServerValue.TIMESTAMP,
        });

        return { id: newClientRef.key, clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed, groupId };
    } catch (error) {
        console.error("Error adding client:", error);
        throw error;
    }
};

//Delete a client by their ID (must belong to the caller's group)
export const deleteClient = async (clientId, groupId) => {
    try {
        const clientRef = admin.database(app).ref(`clients/${clientId}`);
        const clientSnapshot = await clientRef.once("value");

        if (!clientSnapshot.exists() || clientSnapshot.val().groupId !== groupId) {
            throw new Error("Client not found");
        }

        await clientRef.remove();
        return { id: clientId, ...clientSnapshot.val() };
    } catch (error) {
        console.error("Error deleting client:", error);
        throw error;
    }
};

//Edit a client's details by their ID (must belong to the caller's group)
export const editClient = async (clientId, { clientName, businessName, email, whatsappNumber, clientNotes, servicesAvailed } = {}, groupId) => {
    try {
        const clientRef = admin.database(app).ref(`clients/${clientId}`);
        const clientSnapshot = await clientRef.once("value");

        if (!clientSnapshot.exists() || clientSnapshot.val().groupId !== groupId) {
            throw new Error("Client not found");
        }

        if (servicesAvailed !== undefined) {
            await validateServicesExist(servicesAvailed, groupId);
        }

        const updatedData = {};
        if (clientName !== undefined) updatedData.clientName = clientName;
        if (businessName !== undefined) updatedData.businessName = businessName;
        if (email !== undefined) updatedData.email = email;
        if (whatsappNumber !== undefined) updatedData.whatsappNumber = whatsappNumber;
        if (clientNotes !== undefined) updatedData.clientNotes = clientNotes;
        if (servicesAvailed !== undefined) updatedData.servicesAvailed = servicesAvailed;
        const finalData = { ...clientSnapshot.val(), ...updatedData };
        await clientRef.set(finalData);
        return { id: clientId, ...finalData };
    } catch (error) {
        console.error("Error editing client:", error);
        throw error;
    }
};

//client inquiry function (a client sends an inquiry to the business) — not scoped by group, public contact form
export const clientInquiry = async (clientName, email, message) => {
    try {
        const inquiriesRef = admin.database(app).ref("inquiries");
        const newInquiryRef = inquiriesRef.push();
        await newInquiryRef.set({
            clientName,
            email,
            message,
            createdAt: admin.database.ServerValue.TIMESTAMP,
        });

        return { id: newInquiryRef.key, clientName, email, message };
    } catch (error) {
        console.error("Error sending client inquiry:", error);
        throw error;
    }
};
```

- [ ] **Step 2: Verify syntax**

```bash
node --check models/clients.js
```

- [ ] **Step 3: Verify against the real database**

Exercise `addClient` → `editClient` → confirm `getAllClients` reflects the edit → `deleteClient`. Also exercise `clientInquiry` (no group scoping, simplest path).

- [ ] **Step 4: Commit**

```bash
git add models/clients.js
git commit -m "Migrate models/clients.js to Firebase Admin SDK"
```

---

## Task 7: Migrate `scripts/backfill-submission-to-livelink.js` to the Admin SDK

**Files:**
- Modify: `/Users/eugenelinsangan/crm-proj/scripts/backfill-submission-to-livelink.js`
- Test: `node --check` + a real dry run

**Interfaces:**
- Consumes: `app` from Task 1; `normalizeLiveLink` from `models/task.js` (Task 2) — this import and its usage are pure-function calls, unaffected by the SDK swap, no changes needed to that part.

- [ ] **Step 1: Replace the full file contents**

```js
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

import admin from "firebase-admin";
import { app } from "../config/firebase.js";
import { normalizeLiveLink } from "../models/task.js";

const db = admin.database(app);
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
```

- [ ] **Step 2: Verify syntax**

```bash
node --check scripts/backfill-submission-to-livelink.js
```

- [ ] **Step 3: Run a real dry run**

```bash
node scripts/backfill-submission-to-livelink.js
```

Expected: same style of output as before (target database URL, then the candidate list or "No tasks need migrating") — do NOT run with `--apply` as part of this task.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-submission-to-livelink.js
git commit -m "Migrate scripts/backfill-submission-to-livelink.js to Firebase Admin SDK"
```

---

## Task 8: Add `database.rules.json` to the repo (version control only — not deployed yet)

**Files:**
- Create: `/Users/eugenelinsangan/crm-proj/database.rules.json`
- Test: valid JSON (see Step 2)

**Interfaces:**
- Produces: nothing consumed by other tasks — this file is not read by any code, it's the source-of-truth document for what gets manually pasted into the Firebase Console in Task 10.

- [ ] **Step 1: Create the file**

```json
{
  "rules": {
    ".read": true,
    ".write": false,
    "taskStatuses": {
      ".indexOn": ["groupId"]
    },
    "tasks": {
      ".indexOn": ["groupId"]
    },
    "clients": {
      ".indexOn": ["groupId"]
    },
    "services": {
      ".indexOn": ["groupId"]
    },
    "departments": {
      ".indexOn": ["groupId"]
    }
  }
}
```

- [ ] **Step 2: Verify it's valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('database.rules.json', 'utf8')); console.log('Valid JSON.')"
```

- [ ] **Step 3: Commit**

```bash
git add database.rules.json
git commit -m "Add database.rules.json: version-controlled RTDB rules (write lockdown + indexes)"
```

Note: creating this file does NOT change your live Firebase rules — that only happens when its contents are pasted into the Firebase Console (Task 10), since this repo has no `firebase.json`/CLI deploy target set up (explicitly out of scope per the design spec).

---

## Task 9: Stage 1 verification — full exercise of every collection with rules still open

**Files:**
- None modified — this is a verification-only task.
- Test: manual, comprehensive (see Step 1)

**Interfaces:**
- Consumes: every function from Tasks 2-7, now all converted to the Admin SDK.

This is the "confirm everything still works" checkpoint before touching the live rules. At this point in the plan, RTDB rules are still exactly what they were before this plan started (`.read: true, .write: true`) — nothing has been deployed from Task 8 yet. Every write in this step succeeds via BOTH the open rules AND the Admin SDK's rules-bypass; that's expected and fine. The point of this task is to catch any Admin SDK conversion mistake (a missed `.once("value")`, a wrong `ServerValue.TIMESTAMP` reference, etc.) before Task 10 makes rules matter.

- [ ] **Step 1: Start the backend and exercise every collection**

```bash
cd /Users/eugenelinsangan/crm-proj
npm run dev
```

Through the GraphQL API (via the frontend, Apollo sandbox, or curl with a valid session), for each collection, do a full create → read → update → delete cycle (or the closest equivalent the model supports) and confirm the data is correct at every step by checking the Firebase Console's Data view directly, not just the API's returned JSON:

- **tasks**: `addTask` → `editTask` → `submitTask` → `reviewTask` → `deleteTask`
- **recurringTasks**: `addRecurringTask` (confirm it also creates a real task instance) → `pauseRecurringTask` → `resumeRecurringTask` → `deleteRecurringTask`
- **services**: `addService` → `updateService` → `deleteService`
- **taskStatuses**: `addTaskStatus` → `updateTaskStatus` → `deleteTaskStatus`
- **departments**: `addDepartment` → `addMemberToDepartment` → `removeMemberFromDepartment` → `deleteDepartment`
- **clients**: `addClient` → `editClient` → `deleteClient`, plus `clientInquiry`

- [ ] **Step 2: Confirm timestamps are real, not `null` or `NaN`**

Specifically check the Firebase Console for `createdAt` (tasks, departments, clients), `submittedAt` (task submission), `reviewedAt` (task revisions), `assignedAt` (department members) — these all use `admin.database.ServerValue.TIMESTAMP` now. Confirm each shows a real millisecond timestamp in the Console, not a literal string, `null`, or an error.

- [ ] **Step 3: Record the result**

No commit for this task (nothing changed) — but do not proceed to Task 10 until every collection above has been verified working. If anything failed, go back to the relevant Task (2-7) and fix it there, with its own commit, before continuing.

---

## Task 10: Deploy rules to the Firebase Console and verify the lockdown actually works

**Files:**
- None in this repo — this is a manual step in the Firebase Console, plus a final verification.
- Test: manual (see Steps 2-3)

**Interfaces:**
- Consumes: the contents of `database.rules.json` (Task 8).

- [ ] **Step 1: Paste the rules into the Firebase Console**

Go to Firebase Console → your project → Realtime Database → Rules tab. Replace the current contents with the exact contents of `database.rules.json` (Task 8) and click Publish.

- [ ] **Step 2: Confirm the backend still writes (proving Admin SDK genuinely bypasses rules)**

Repeat one write from each collection in Task 9's list (a single `addTask`, `addClient`, etc. is enough this time — full re-verification isn't needed, just confirmation nothing broke). Expected: all succeed exactly as before, since the Admin SDK connection never goes through rules at all.

- [ ] **Step 3: Confirm a direct unauthenticated write is now rejected**

```bash
curl -s -X PUT "https://crm-backend-df5ea-default-rtdb.asia-southeast1.firebasedatabase.app/tasks/__rules_test__.json" -d '{"fake":"data"}'
```

Expected: an error response body mentioning permission denied (something like `{"error":"Permission denied"}`), NOT a success response. Then confirm nothing was written by checking `tasks/__rules_test__` doesn't exist in the Firebase Console — this proves the write lockdown is actually in effect, not just configured.

- [ ] **Step 4: Confirm reads are still open (unchanged by this plan, on purpose)**

```bash
curl -s "https://crm-backend-df5ea-default-rtdb.asia-southeast1.firebasedatabase.app/taskStatuses.json"
```

Expected: returns real data (not a permission error) — reads are intentionally still open; that's Piece 2's problem, tracked as a separate future plan per the design spec.

No commit for this task — the only artifact is the live Console state, which `database.rules.json` (already committed in Task 8) documents.
