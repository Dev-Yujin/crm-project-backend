# Member Deletion Assignment Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `deleteMember` never again leaves a dangling `assignedMembers` UUID reference in Firebase `tasks`/`recurringTasks` — the caller either transfers the departing member's assignments to another member as part of the same delete call, or the delete is refused with a clear, actionable error.

**Architecture:** A new backend model file (`models/memberAssignments.js`) owns counting and transferring task/recurring-task assignments for a member. `deleteMember` gains an optional `reassignTo` parameter: given, it transfers first then deletes; omitted with existing assignments, it throws a `GraphQLError` (`MEMBER_HAS_ASSIGNMENTS`, with counts) instead of deleting. The frontend catches that error code and offers a "reassign to" dropdown right in the existing delete-confirmation dialog.

**Tech Stack:** Node/Express/Apollo GraphQL, Firebase Realtime Database (`firebase-admin/database`), Postgres via `pool` (backend); React/TypeScript, no test suite — verified via `tsc --noEmit` + `oxlint` (frontend); Vitest (backend tests).

## Global Constraints

- `assignedMembers` is `[ID!]!` on both `Task` and `RecurringTask` — always an array (never null), may be empty.
- `tasks` and `recurringTasks` are flat Firebase RTDB collections, each indexed by `groupId`. Reuse the existing indexed readers rather than writing new Firebase read logic: `getAllTasksForGroupIndexed(groupId)` (`models/task.js`) and `getAllRecurringTasks(groupId)` (`models/recurringTasks.js`).
- Model-layer code in this codebase throws `GraphQLError` directly (not a plain `Error`) whenever the frontend needs to distinguish the failure by `extensions.code` — established precedent: `checkRateLimit` in `utils/rateLimit.js` throws `new GraphQLError(message, { extensions: { code: 'RATE_LIMITED' } })`.
- `deleteMember`'s existing signature is `deleteMember(uuid, groupId)`. It gains a 3rd, optional parameter: `reassignTo = null`. Use loose equality (`reassignTo != null`) as the single check for "the caller supplied a reassignment target" — this treats both `undefined` (GraphQL arg omitted) and explicit `null` the same way.
- The frontend's `GraphQLRequestError` (`src/lib/graphql.ts`) currently exposes only `.code`, read off `extensions.code` (see the existing `EMAIL_CREDENTIALS_NOT_CONFIGURED` handling in `src/pages/Members.tsx`). This plan adds a generic `.extensions` bag alongside `.code`, without changing `.code`'s existing behavior — every current caller keeps working unmodified.
- New/changed error text is used verbatim by tests — do not paraphrase when implementing.

---

### Task 1: `models/memberAssignments.js` — count and reassign a member's task/recurring-task assignments

**Files:**
- Create: `models/memberAssignments.js`
- Test: `models/memberAssignments.test.js`

**Interfaces:**
- Consumes: `getAllTasksForGroupIndexed(groupId)` from `models/task.js` (already exists, returns `[{ id, ...taskFields }]`, no `assignedMembers` defaulting — treat a missing `assignedMembers` as absent, not `[]`); `getAllRecurringTasks(groupId)` from `models/recurringTasks.js` (already exists, returns `[{ id, ...templateFields }]`, same caveat); `getDatabase` from `firebase-admin/database`; `app` from `../config/firebase.js`.
- Produces:
  - `countMemberAssignments(uuid, groupId) => Promise<{ taskCount: number, recurringTaskCount: number }>`
  - `reassignMemberAssignments(oldUuid, newUuid, groupId) => Promise<{ tasksTransferred: number, recurringTasksTransferred: number }>`
  Both are consumed by Task 2's `deleteMember`.

- [ ] **Step 1: Write the failing tests**

Create `models/memberAssignments.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));

const mockRootRef = { update: vi.fn(async () => {}) };
const mockDb = { ref: vi.fn(() => mockRootRef) };

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock('./task.js', () => ({
  getAllTasksForGroupIndexed: vi.fn(),
}));
vi.mock('./recurringTasks.js', () => ({
  getAllRecurringTasks: vi.fn(),
}));

const { getAllTasksForGroupIndexed } = await import('./task.js');
const { getAllRecurringTasks } = await import('./recurringTasks.js');
const { countMemberAssignments, reassignMemberAssignments } = await import('./memberAssignments.js');

describe('countMemberAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts tasks and recurring tasks that reference the uuid, across both collections independently', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([
      { id: 't1', assignedMembers: ['m1', 'm2'] },
      { id: 't2', assignedMembers: ['m2'] },
    ]);
    getAllRecurringTasks.mockResolvedValue([
      { id: 'rt1', assignedMembers: ['m1'] },
    ]);

    const result = await countMemberAssignments('m1', 'g1');
    expect(result).toEqual({ taskCount: 1, recurringTaskCount: 1 });
  });

  it('returns zero counts for a member with no assignments', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([{ id: 't1', assignedMembers: ['m2'] }]);
    getAllRecurringTasks.mockResolvedValue([]);

    const result = await countMemberAssignments('m1', 'g1');
    expect(result).toEqual({ taskCount: 0, recurringTaskCount: 0 });
  });

  it('treats a record with no assignedMembers field as unassigned, not a crash', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([{ id: 't1' }]);
    getAllRecurringTasks.mockResolvedValue([{ id: 'rt1' }]);

    const result = await countMemberAssignments('m1', 'g1');
    expect(result).toEqual({ taskCount: 0, recurringTaskCount: 0 });
  });
});

describe('reassignMemberAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRootRef.update.mockResolvedValue(undefined);
  });

  it('replaces the old uuid with the new one in both collections and reports counts', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([
      { id: 't1', assignedMembers: ['m1', 'm3'] },
      { id: 't2', assignedMembers: ['m3'] },
    ]);
    getAllRecurringTasks.mockResolvedValue([
      { id: 'rt1', assignedMembers: ['m1'] },
    ]);

    const result = await reassignMemberAssignments('m1', 'm2', 'g1');

    expect(mockRootRef.update).toHaveBeenCalledWith({
      'tasks/t1/assignedMembers': ['m2', 'm3'],
      'recurringTasks/rt1/assignedMembers': ['m2'],
    });
    expect(result).toEqual({ tasksTransferred: 1, recurringTasksTransferred: 1 });
  });

  it('dedupes when the new uuid is already a co-assignee', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([
      { id: 't1', assignedMembers: ['m1', 'm2'] },
    ]);
    getAllRecurringTasks.mockResolvedValue([]);

    await reassignMemberAssignments('m1', 'm2', 'g1');

    expect(mockRootRef.update).toHaveBeenCalledWith({
      'tasks/t1/assignedMembers': ['m2'],
    });
  });

  it('does not call update when nothing references the old uuid', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([{ id: 't1', assignedMembers: ['m9'] }]);
    getAllRecurringTasks.mockResolvedValue([]);

    const result = await reassignMemberAssignments('m1', 'm2', 'g1');

    expect(mockRootRef.update).not.toHaveBeenCalled();
    expect(result).toEqual({ tasksTransferred: 0, recurringTasksTransferred: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run models/memberAssignments.test.js`
Expected: FAIL — `models/memberAssignments.js` does not exist yet (`Cannot find module './memberAssignments.js'` or similar).

- [ ] **Step 3: Write the implementation**

Create `models/memberAssignments.js`:

```js
import { getDatabase } from "firebase-admin/database";
import { app } from "../config/firebase.js";
import { getAllTasksForGroupIndexed } from "./task.js";
import { getAllRecurringTasks } from "./recurringTasks.js";

const db = getDatabase(app);

//How many tasks/recurring tasks in a group still have `uuid` in their assignedMembers —
//used by deleteMember to decide whether it's safe to delete outright.
export const countMemberAssignments = async (uuid, groupId) => {
    const [tasks, recurringTasks] = await Promise.all([
        getAllTasksForGroupIndexed(groupId),
        getAllRecurringTasks(groupId),
    ]);

    const taskCount = tasks.filter((task) => (task.assignedMembers ?? []).includes(uuid)).length;
    const recurringTaskCount = recurringTasks.filter((template) => (template.assignedMembers ?? []).includes(uuid)).length;

    return { taskCount, recurringTaskCount };
};

//Replace oldUuid with newUuid in assignedMembers across every task/recurring task in the
//group that references oldUuid — used by deleteMember when the caller supplies a
//reassignment target. Dedupes via Set in case newUuid is already a co-assignee. A single
//multi-location update() applies every change in one Firebase write.
export const reassignMemberAssignments = async (oldUuid, newUuid, groupId) => {
    const [tasks, recurringTasks] = await Promise.all([
        getAllTasksForGroupIndexed(groupId),
        getAllRecurringTasks(groupId),
    ]);

    const matchingTasks = tasks.filter((task) => (task.assignedMembers ?? []).includes(oldUuid));
    const matchingRecurringTasks = recurringTasks.filter((template) => (template.assignedMembers ?? []).includes(oldUuid));

    const updates = {};
    for (const task of matchingTasks) {
        updates[`tasks/${task.id}/assignedMembers`] = [
            ...new Set(task.assignedMembers.map((id) => (id === oldUuid ? newUuid : id))),
        ];
    }
    for (const template of matchingRecurringTasks) {
        updates[`recurringTasks/${template.id}/assignedMembers`] = [
            ...new Set(template.assignedMembers.map((id) => (id === oldUuid ? newUuid : id))),
        ];
    }

    if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
    }

    return {
        tasksTransferred: matchingTasks.length,
        recurringTasksTransferred: matchingRecurringTasks.length,
    };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run models/memberAssignments.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add models/memberAssignments.js models/memberAssignments.test.js
git commit -m "feat: add memberAssignments model for counting/transferring member task assignments"
```

---

### Task 2: `deleteMember` gains reassign-or-block behavior

**Files:**
- Modify: `models/membersFunction.js:114-128` (the `deleteMember` function)
- Modify: `typedefs/memberTypeDefs.js:26`
- Modify: `resolvers/memberResolvers.js:102-106`
- Test: `models/membersFunction.test.js`

**Interfaces:**
- Consumes: `countMemberAssignments(uuid, groupId)` and `reassignMemberAssignments(oldUuid, newUuid, groupId)` from Task 1's `models/memberAssignments.js`; `validateMembersExist(memberUuids, groupId)` from `models/task.js` (already exists, throws `Error("Member(s) not found: ...")` — reuse it exactly as-is, passing `[reassignTo]`).
- Produces: `deleteMember(uuid, groupId, reassignTo = null)` — same return shape as today (the deleted Postgres row) on success; throws `GraphQLError` with `extensions: { code: 'MEMBER_HAS_ASSIGNMENTS', taskCount, recurringTaskCount }` when blocked. Resolver `deleteMember(uuid: ID!, reassignTo: ID): Member!`. Consumed by Task 3's frontend.

- [ ] **Step 1: Write the failing tests**

Add to `models/membersFunction.test.js` (after the existing imports/mocks at the top of the file, before the `describe('loginMember rate limiting', ...)` block):

```js
vi.mock('./task.js', () => ({
  validateMembersExist: vi.fn(async () => {}),
}));
vi.mock('./memberAssignments.js', () => ({
  countMemberAssignments: vi.fn(),
  reassignMemberAssignments: vi.fn(),
}));

const { validateMembersExist } = await import('./task.js');
const { countMemberAssignments, reassignMemberAssignments } = await import('./memberAssignments.js');
```

Change this existing line:

```js
const { loginMember } = await import('./membersFunction.js');
```

to:

```js
const { loginMember, deleteMember } = await import('./membersFunction.js');
```

Then append this new `describe` block at the end of the file:

```js
describe('deleteMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateMembersExist.mockResolvedValue(undefined);
    countMemberAssignments.mockResolvedValue({ taskCount: 0, recurringTaskCount: 0 });
    reassignMemberAssignments.mockResolvedValue({ tasksTransferred: 0, recurringTasksTransferred: 0 });
    pool.query.mockResolvedValue({
      rows: [{ uuid: 'm1', username: 'old', email: 'old@x.com', group_id: 'g1', created_at: new Date() }],
    });
  });

  it('deletes normally when the member has no assignments', async () => {
    const result = await deleteMember('m1', 'g1');
    expect(result.uuid).toBe('m1');
    expect(reassignMemberAssignments).not.toHaveBeenCalled();
  });

  it('blocks the delete with MEMBER_HAS_ASSIGNMENTS when the member has assignments and no reassignTo', async () => {
    countMemberAssignments.mockResolvedValue({ taskCount: 3, recurringTaskCount: 1 });

    await expect(deleteMember('m1', 'g1')).rejects.toMatchObject({
      extensions: { code: 'MEMBER_HAS_ASSIGNMENTS', taskCount: 3, recurringTaskCount: 1 },
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('reassigns then deletes when a valid reassignTo is given', async () => {
    reassignMemberAssignments.mockResolvedValue({ tasksTransferred: 3, recurringTasksTransferred: 1 });

    const result = await deleteMember('m1', 'g1', 'm2');

    expect(validateMembersExist).toHaveBeenCalledWith(['m2'], 'g1');
    expect(reassignMemberAssignments).toHaveBeenCalledWith('m1', 'm2', 'g1');
    expect(countMemberAssignments).not.toHaveBeenCalled();
    expect(result.uuid).toBe('m1');
  });

  it('rejects reassigning to the member being deleted', async () => {
    await expect(deleteMember('m1', 'g1', 'm1')).rejects.toThrow(
      'Cannot reassign to the member being deleted',
    );
    expect(reassignMemberAssignments).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a reassignTo that does not exist or belongs to another group', async () => {
    validateMembersExist.mockRejectedValue(new Error('Member(s) not found: m2'));

    await expect(deleteMember('m1', 'g1', 'm2')).rejects.toThrow('Member(s) not found: m2');
    expect(reassignMemberAssignments).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
```

Note: `pool` is already imported at the top of this test file via `const { pool } = await import('../config/supabase.js');` — reuse it, do not re-import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run models/membersFunction.test.js`
Expected: FAIL — `deleteMember` is not exported with this signature yet / does not import `memberAssignments.js` yet, so assertions about blocking, reassigning, etc. fail (existing `deleteMember` just deletes unconditionally).

- [ ] **Step 3: Write the implementation**

In `models/membersFunction.js`, add these imports at the top (alongside the existing ones):

```js
import { GraphQLError } from 'graphql';
import { validateMembersExist } from './task.js';
import { countMemberAssignments, reassignMemberAssignments } from './memberAssignments.js';
```

Replace the existing `deleteMember` function (lines 113-128) with:

```js
//Delete member function (must belong to the caller's group). If the member still has
//task/recurring-task assignments, the caller must either supply reassignTo (an existing
//member in the same group to transfer those assignments to first) or the delete is
//refused — deleteMember never silently leaves a dangling assignedMembers reference behind.
export const deleteMember = async (uuid, groupId, reassignTo = null) => {
    try {
        if (reassignTo != null) {
            if (reassignTo === uuid) {
                throw new Error('Cannot reassign to the member being deleted');
            }
            await validateMembersExist([reassignTo], groupId);
            await reassignMemberAssignments(uuid, reassignTo, groupId);
        } else {
            const { taskCount, recurringTaskCount } = await countMemberAssignments(uuid, groupId);
            if (taskCount > 0 || recurringTaskCount > 0) {
                throw new GraphQLError(
                    `This member still has ${taskCount} task(s) and ${recurringTaskCount} recurring task(s) assigned. Provide reassignTo to transfer them first, or reassign manually.`,
                    { extensions: { code: 'MEMBER_HAS_ASSIGNMENTS', taskCount, recurringTaskCount } }
                );
            }
        }

        const query = 'DELETE FROM members WHERE uuid = $1 AND group_id = $2 RETURNING uuid, username, email, group_id, created_at';
        const result = await pool.query(query, [uuid, groupId]);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        return result.rows[0];
    } catch (error) {
        console.error('Error deleting member:', error);
        throw error;
    }
};
```

In `typedefs/memberTypeDefs.js`, change line 26 from:

```graphql
    deleteMember(uuid: ID!): Member!
```

to:

```graphql
    deleteMember(uuid: ID!, reassignTo: ID): Member!
```

In `resolvers/memberResolvers.js`, change the `deleteMember` resolver (lines 102-106) from:

```js
        deleteMember: async (_, { uuid }, context) => {
            const groupId = requireGroup(context);
            const member = await deleteMember(uuid, groupId);
            return mapMember(member);
        },
```

to:

```js
        deleteMember: async (_, { uuid, reassignTo }, context) => {
            const groupId = requireGroup(context);
            const member = await deleteMember(uuid, groupId, reassignTo);
            return mapMember(member);
        },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run models/membersFunction.test.js`
Expected: PASS (existing 4 rate-limiting tests + 5 new `deleteMember` tests)

Then run the full backend suite to confirm nothing else broke:

Run: `npm test`
Expected: PASS, 148 + 6 (Task 1) + 5 (Task 2) = 159 tests passing

- [ ] **Step 5: Commit**

```bash
git add models/membersFunction.js models/membersFunction.test.js typedefs/memberTypeDefs.js resolvers/memberResolvers.js
git commit -m "feat: block or auto-reassign a departing member's task assignments on delete"
```

---

### Task 3: Frontend — reassignment prompt on the member-delete flow

**Files:**
- Modify: `src/lib/graphql.ts` (the `GraphQLRequestError` class and `graphqlRequest` function)
- Modify: `src/lib/queries.ts:189-193` (`DELETE_MEMBER`)
- Modify: `src/components/ui/ConfirmDialog.tsx`
- Modify: `src/pages/Members.tsx`

**Interfaces:**
- Consumes: Task 2's `deleteMember(uuid: ID!, reassignTo: ID): Member!` mutation and its `MEMBER_HAS_ASSIGNMENTS` error code with `extensions.taskCount` / `extensions.recurringTaskCount`.
- Produces: no new exports consumed elsewhere — this is the final, user-facing task. No automated tests (this repo has none); verify via `tsc --noEmit`, `oxlint`, and manual/live verification.

- [ ] **Step 1: Extend `GraphQLRequestError` to carry the raw extensions bag**

In `src/lib/graphql.ts`, replace:

```ts
export class GraphQLRequestError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'GraphQLRequestError';
    this.code = code;
  }
}
```

with:

```ts
export class GraphQLRequestError extends Error {
  code?: string;
  extensions?: Record<string, unknown>;
  constructor(message: string, code?: string, extensions?: Record<string, unknown>) {
    super(message);
    this.name = 'GraphQLRequestError';
    this.code = code;
    this.extensions = extensions;
  }
}
```

And replace:

```ts
  if (json.errors) {
    const err = json.errors[0];
    throw new GraphQLRequestError(err?.message ?? 'GraphQL request failed', err?.extensions?.code);
  }
```

with:

```ts
  if (json.errors) {
    const err = json.errors[0];
    throw new GraphQLRequestError(err?.message ?? 'GraphQL request failed', err?.extensions?.code, err?.extensions);
  }
```

- [ ] **Step 2: Update `DELETE_MEMBER` to accept `reassignTo`**

In `src/lib/queries.ts`, replace:

```ts
export const DELETE_MEMBER = `
  mutation DeleteMember($uuid: ID!) {
    deleteMember(uuid: $uuid) { uuid username email }
  }
`;
```

with:

```ts
export const DELETE_MEMBER = `
  mutation DeleteMember($uuid: ID!, $reassignTo: ID) {
    deleteMember(uuid: $uuid, reassignTo: $reassignTo) { uuid username email }
  }
`;
```

- [ ] **Step 3: Let `ConfirmDialog` accept extra content and a disabled confirm button**

In `src/components/ui/ConfirmDialog.tsx`, replace the whole file with:

```tsx
import type { ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  loading,
  danger = true,
  confirmDisabled = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  loading?: boolean;
  danger?: boolean;
  confirmDisabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <p className="text-sm text-ink/60 dark:text-white/60">{description}</p>}
      {children}
    </Modal>
  );
}
```

This is backward compatible: `confirmDisabled` defaults to `false` and `children` defaults to `undefined` (renders nothing), so every other existing `ConfirmDialog` caller (Team.tsx, Services.tsx, RecurringTasks.tsx, Calendar.tsx, TaskStatuses.tsx, Inquiries.tsx, Departments.tsx, MemberPortal.tsx, TaskAttachmentField.tsx, TaskDetailModal.tsx, NotesView.tsx, Clients.tsx) is unaffected.

- [ ] **Step 4: Wire up the reassignment prompt in `Members.tsx`**

Add `Select` to the existing Field import — change:

```ts
import { Input, PasswordInput } from '../components/ui/Field';
```

to:

```ts
import { Input, PasswordInput, Select } from '../components/ui/Field';
```

Add new state alongside the existing `deleteTarget`/`deleting` state (near line 35-36):

```ts
  const [reassignPrompt, setReassignPrompt] = useState<{
    taskCount: number;
    recurringTaskCount: number;
  } | null>(null);
  const [reassignTo, setReassignTo] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
```

Replace `handleDelete` (lines 122-132):

```ts
  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await graphqlRequest(DELETE_MEMBER, { uuid: deleteTarget.uuid });
      setDeleteTarget(null);
      membersQ.refetch();
    } finally {
      setDeleting(false);
    }
  }
```

with:

```ts
  function resetDeleteState() {
    setDeleteTarget(null);
    setReassignPrompt(null);
    setReassignTo('');
    setDeleteError(null);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await graphqlRequest(DELETE_MEMBER, {
        uuid: deleteTarget.uuid,
        reassignTo: reassignPrompt ? reassignTo : undefined,
      });
      resetDeleteState();
      membersQ.refetch();
    } catch (err) {
      if (err instanceof GraphQLRequestError && err.code === 'MEMBER_HAS_ASSIGNMENTS') {
        setReassignPrompt({
          taskCount: Number(err.extensions?.taskCount ?? 0),
          recurringTaskCount: Number(err.extensions?.recurringTaskCount ?? 0),
        });
      } else {
        setDeleteError(err instanceof Error ? err.message : 'Failed to delete member.');
      }
    } finally {
      setDeleting(false);
    }
  }
```

Replace the `ConfirmDialog` block near the end of the file (lines 290-297):

```tsx
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete member?"
        description={`"${deleteTarget?.username}" will be permanently removed and unassigned from all departments and tasks.`}
      />
```

with:

```tsx
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={resetDeleteState}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete member?"
        confirmLabel={reassignPrompt ? 'Reassign & Delete' : 'Delete'}
        confirmDisabled={!!reassignPrompt && !reassignTo}
        description={
          reassignPrompt
            ? `"${deleteTarget?.username}" has ${reassignPrompt.taskCount} task(s) and ${reassignPrompt.recurringTaskCount} recurring task(s) assigned. Choose who should take over their work before deleting.`
            : `"${deleteTarget?.username}" will be permanently removed and unassigned from all departments and tasks.`
        }
      >
        {reassignPrompt && (
          <Select
            label="Reassign to"
            required
            value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)}
          >
            <option value="" disabled>
              Select a member
            </option>
            {members
              .filter((m) => m.uuid !== deleteTarget?.uuid)
              .map((m) => (
                <option key={m.uuid} value={m.uuid}>
                  {m.username}
                </option>
              ))}
          </Select>
        )}
        {deleteError && <Banner tone="error">{deleteError}</Banner>}
      </ConfirmDialog>
```

- [ ] **Step 5: Verify with `tsc` and `oxlint`**

Run: `npx tsc --noEmit`
Expected: same pre-existing `baseUrl` deprecation notice as the worktree baseline, no new errors.

Run: `npx oxlint`
Expected: same pre-existing warnings as the worktree baseline, no new errors.

- [ ] **Step 6: Manual/live verification**

Start the dev server and, against a real group with at least two members:
1. Delete a member with no task/recurring-task assignments — confirm it succeeds exactly as before, no prompt shown.
2. Give a member at least one task and one recurring-task assignment, then try to delete them — confirm the dialog switches to the reassignment prompt showing the correct counts, "Reassign & Delete" is disabled until a member is picked, and picking a member and confirming both transfers the assignments (spot-check one task/recurring task now shows the new member) and deletes the original member.
3. Confirm editing one of the transferred tasks afterward does not throw `Member(s) not found`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/graphql.ts src/lib/queries.ts src/components/ui/ConfirmDialog.tsx src/pages/Members.tsx
git commit -m "feat: prompt to reassign a member's task assignments before deleting them"
```
