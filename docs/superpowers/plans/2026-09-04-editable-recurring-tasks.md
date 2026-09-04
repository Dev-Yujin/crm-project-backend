# Editable Recurring Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recurring task templates in "Continuum CRM" can be edited in place (reassign to a different member/admin, change client, department, task name/description, service, recurrence, priority) instead of the current "Duplicate" workaround, which always creates a second template and leaves the original untouched.

**Architecture:** Add a new `editRecurringTask` GraphQL mutation on the backend, mirroring the existing `editTask` mutation's exact partial-update convention (every field but the id is optional; an omitted field leaves the stored value unchanged). On the frontend, extend the existing `RecurringTaskFormModal` (currently used only for create/duplicate) with a new `isEditing` mode that calls the new mutation instead of `addRecurringTask`, and add a new "Edit" button alongside the existing "Duplicate" button. Also flip the `RECURRING_TASK_DEPARTMENT` feature flag on, since it's been live in production since before this plan but the frontend flag was never updated.

**Tech Stack:** Node.js/Express/Apollo GraphQL + Firebase Realtime Database (backend, crm-proj — recurring tasks live in RTDB, not Postgres), React/TypeScript (frontend, crm-frontend), Vitest (backend tests only — no test suite in the frontend repo).

## Global Constraints

- `editRecurringTask`'s only required argument is `recurringTaskId`; every other field is optional, and an omitted (`undefined`) argument must leave that field's stored value unchanged — never write `undefined` into Firebase.
- Editing must never touch `nextRunAt`, `lastRunAt`, or `active` — this is what makes a `recurrence` change take effect starting from the run *after* the one already scheduled, not immediately (the scheduler only reads `recurrence` fresh when it computes the next `nextRunAt`, after firing — see `runDueRecurringTasks` in `models/recurringTasks.js`, unmodified by this plan).
- The existing "Duplicate" action and its exact current behavior (always creates a new template, never deletes/touches the original) must be fully preserved — Edit is a new, separate action, not a replacement.
- `RECURRING_TASK_DEPARTMENT` flips from `false` to `true` — confirmed live in production via a direct query returning `UNAUTHENTICATED` (not a schema-validation error) on 2026-09-04.
- Recurring tasks remain admin-only end to end (`requireGroup`, not `requireCallerGroupId`) — this plan does not add a member-facing path, matching every existing recurring-task mutation.
- Editable fields, exactly matching what the create form already supports: `clientId`, `clientName`, `taskName`, `taskDescription`, `serviceId`, `assignedMembers`, `recurrence`, `priority`, `assignedUsers`, `departmentId`.

---

### Task 1: Backend — `editRecurringTask` mutation (typedef, model, resolver)

**Files:**
- Modify: `typedefs/recurringTaskTypeDefs.js`
- Modify: `models/recurringTasks.js`
- Modify: `resolvers/recurringTaskResolvers.js`
- Test: `models/recurringTasks.test.js` (new — no test file exists for this module today)

**Interfaces:**
- Produces: `editRecurringTask(recurringTaskId, updates, groupId)` — the model function. `updates` is a plain object that may contain any subset of `clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, recurrence, priority, assignedUsers, departmentId`; any key not present in `updates` leaves that field's stored value untouched. Throws `Error("Recurring task not found")` if `recurringTaskId` doesn't exist or belongs to a different group. Returns the updated template shape (`{ id, ...fields }`), same shape `getAllRecurringTasks`/`addRecurringTask` already return.
- Produces (GraphQL): `editRecurringTask(recurringTaskId: ID!, clientId: ID, clientName: String, taskName: String, taskDescription: String, serviceId: ID, assignedMembers: [ID!], recurrence: Recurrence, priority: TaskPriority, assignedUsers: [ID!], departmentId: ID): RecurringTask!`

- [ ] **Step 1: Add the typedef**

In `typedefs/recurringTaskTypeDefs.js`, find:
```graphql
  type Mutation {
    addRecurringTask(
      clientId: ID!
      clientName: String!
      taskName: String!
      taskDescription: String!
      serviceId: ID!
      assignedMembers: [ID!]!
      recurrence: Recurrence!
      priority: TaskPriority
      assignedUsers: [ID!]
      departmentId: ID
    ): RecurringTask!
    deleteRecurringTask(recurringTaskId: ID!): Boolean!
```
Change to:
```graphql
  type Mutation {
    addRecurringTask(
      clientId: ID!
      clientName: String!
      taskName: String!
      taskDescription: String!
      serviceId: ID!
      assignedMembers: [ID!]!
      recurrence: Recurrence!
      priority: TaskPriority
      assignedUsers: [ID!]
      departmentId: ID
    ): RecurringTask!
    editRecurringTask(
      recurringTaskId: ID!
      clientId: ID
      clientName: String
      taskName: String
      taskDescription: String
      serviceId: ID
      assignedMembers: [ID!]
      recurrence: Recurrence
      priority: TaskPriority
      assignedUsers: [ID!]
      departmentId: ID
    ): RecurringTask!
    deleteRecurringTask(recurringTaskId: ID!): Boolean!
```

- [ ] **Step 2: Write the failing tests**

Create `models/recurringTasks.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));

const mockRef = {
  once: vi.fn(),
  update: vi.fn(async () => {}),
};
const mockDb = { ref: vi.fn(() => mockRef) };

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock('./task.js', async () => {
  const actual = await vi.importActual('./task.js');
  return {
    ...actual,
    validateMembersExist: vi.fn(async () => {}),
    validateServiceForClient: vi.fn(async () => {}),
    addTask: vi.fn(async () => ({})),
  };
});
vi.mock('./groups.js', () => ({
  validateUsersExist: vi.fn(async () => {}),
}));
vi.mock('./departments.js', () => ({
  validateDepartmentExists: vi.fn(async () => {}),
}));

const { validateMembersExist, validateServiceForClient } = await import('./task.js');
const { validateUsersExist } = await import('./groups.js');
const { validateDepartmentExists } = await import('./departments.js');
const { editRecurringTask } = await import('./recurringTasks.js');

const baseTemplate = {
  clientId: 'c1',
  clientName: 'Acme',
  taskName: 'Old name',
  taskDescription: 'Old description',
  serviceId: 's1',
  assignedMembers: ['m1'],
  assignedUsers: ['u1'],
  priority: 'MEDIUM',
  recurrence: 'DAILY',
  createdBy: 'admin:1',
  active: true,
  lastRunAt: 1000,
  nextRunAt: 2000,
  departmentId: 'd1',
  groupId: 'g1',
};

describe('editRecurringTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({ ...baseTemplate }),
    });
    mockRef.update.mockResolvedValue(undefined);
  });

  it('updates only the fields passed, leaving nextRunAt/lastRunAt/active untouched', async () => {
    await editRecurringTask('rt1', { taskName: 'New name' }, 'g1');

    expect(mockRef.update).toHaveBeenCalledWith({ taskName: 'New name' });
  });

  it('rejects when the template does not exist', async () => {
    mockRef.once.mockResolvedValue({ exists: () => false, val: () => null });

    await expect(editRecurringTask('missing', { taskName: 'x' }, 'g1')).rejects.toThrow(
      'Recurring task not found',
    );
    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('rejects when the template belongs to a different group', async () => {
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({ ...baseTemplate, groupId: 'other-group' }),
    });

    await expect(editRecurringTask('rt1', { taskName: 'x' }, 'g1')).rejects.toThrow(
      'Recurring task not found',
    );
    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('validates assignedMembers only when it is being changed', async () => {
    await editRecurringTask('rt1', { assignedMembers: ['m2'] }, 'g1');
    expect(validateMembersExist).toHaveBeenCalledWith(['m2'], 'g1');

    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ ...baseTemplate }) });
    await editRecurringTask('rt1', { taskName: 'New name' }, 'g1');
    expect(validateMembersExist).not.toHaveBeenCalled();
  });

  it('validates assignedUsers only when it is being changed', async () => {
    await editRecurringTask('rt1', { assignedUsers: ['u2'] }, 'g1');
    expect(validateUsersExist).toHaveBeenCalledWith(['u2'], 'g1');
  });

  it('validates the client/service pair, falling back to the stored value for whichever was not passed', async () => {
    await editRecurringTask('rt1', { clientId: 'c2' }, 'g1');
    expect(validateServiceForClient).toHaveBeenCalledWith('c2', 's1', 'g1');

    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ ...baseTemplate }) });
    await editRecurringTask('rt1', { serviceId: 's2' }, 'g1');
    expect(validateServiceForClient).toHaveBeenCalledWith('c1', 's2', 'g1');
  });

  it('validates departmentId only when it is being changed', async () => {
    await editRecurringTask('rt1', { departmentId: 'd2' }, 'g1');
    expect(validateDepartmentExists).toHaveBeenCalledWith('d2', 'g1');
  });

  it('dedupes assignedUsers when provided', async () => {
    await editRecurringTask('rt1', { assignedUsers: ['u2', 'u2', 'u3'] }, 'g1');
    expect(mockRef.update).toHaveBeenCalledWith({ assignedUsers: ['u2', 'u3'] });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run models/recurringTasks.test.js`
Expected: FAIL — `editRecurringTask` is not exported from `./recurringTasks.js` yet (import error), or every test fails since the function doesn't exist.

- [ ] **Step 4: Implement `editRecurringTask` in `models/recurringTasks.js`**

Find:
```js
//Fetch all recurring task templates belonging to a group
export const getAllRecurringTasks = async (groupId) => {
```
Insert this new function directly above it (after `addRecurringTask`, before `getAllRecurringTasks`):
```js
//Edit a recurring task template in place — only the fields provided are changed; anything
//omitted (undefined) keeps its stored value. Never touches nextRunAt/lastRunAt/active, so a
//recurrence change takes effect starting from the run after the one already scheduled, not
//immediately — the scheduler only reads `recurrence` fresh when it computes the *next*
//nextRunAt after a run fires (see runDueRecurringTasks below). Must belong to the caller's group.
export const editRecurringTask = async (recurringTaskId, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, recurrence, priority, assignedUsers, departmentId } = {}, groupId) => {
    try {
        const templateRef = db.ref(`recurringTasks/${recurringTaskId}`);
        const snapshot = await templateRef.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Recurring task not found");
        }

        const template = snapshot.val();

        if (assignedMembers !== undefined) {
            await validateMembersExist(assignedMembers, groupId);
        }

        if (assignedUsers !== undefined) {
            await validateUsersExist(assignedUsers, groupId);
        }

        if (clientId !== undefined || serviceId !== undefined) {
            await validateServiceForClient(
                clientId !== undefined ? clientId : template.clientId,
                serviceId !== undefined ? serviceId : template.serviceId,
                groupId
            );
        }

        if (departmentId !== undefined) {
            await validateDepartmentExists(departmentId, groupId);
        }

        const updates = {
            ...(clientId !== undefined && { clientId }),
            ...(clientName !== undefined && { clientName }),
            ...(taskName !== undefined && { taskName }),
            ...(taskDescription !== undefined && { taskDescription }),
            ...(serviceId !== undefined && { serviceId }),
            ...(assignedMembers !== undefined && { assignedMembers }),
            ...(recurrence !== undefined && { recurrence }),
            ...(priority !== undefined && { priority }),
            ...(assignedUsers !== undefined && { assignedUsers: [...new Set(assignedUsers ?? [])] }),
            ...(departmentId !== undefined && { departmentId }),
        };

        await templateRef.update(updates);

        return { id: recurringTaskId, ...template, ...updates };
    } catch (error) {
        console.error("Error editing recurring task:", error);
        throw error;
    }
};

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run models/recurringTasks.test.js`
Expected: PASS — all 8 tests.

- [ ] **Step 6: Wire the resolver**

In `resolvers/recurringTaskResolvers.js`, find:
```js
import {
    getAllRecurringTasks,
    addRecurringTask,
    deleteRecurringTask,
    pauseRecurringTask,
    resumeRecurringTask,
} from '../models/recurringTasks.js';
```
Change to:
```js
import {
    getAllRecurringTasks,
    addRecurringTask,
    editRecurringTask,
    deleteRecurringTask,
    pauseRecurringTask,
    resumeRecurringTask,
} from '../models/recurringTasks.js';
```

Find:
```js
        addRecurringTask: async (_, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, recurrence, priority, assignedUsers, departmentId }, context) => {
            const user = requireUser(context);
            const groupId = requireGroup(context);
            const template = await addRecurringTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, user.id, recurrence, priority, groupId, assignedUsers, departmentId);
            return mapRecurringTask(template);
        },
        deleteRecurringTask: async (_, { recurringTaskId }, context) => {
```
Change to:
```js
        addRecurringTask: async (_, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, recurrence, priority, assignedUsers, departmentId }, context) => {
            const user = requireUser(context);
            const groupId = requireGroup(context);
            const template = await addRecurringTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, user.id, recurrence, priority, groupId, assignedUsers, departmentId);
            return mapRecurringTask(template);
        },
        editRecurringTask: async (_, { recurringTaskId, ...updates }, context) => {
            const groupId = requireGroup(context);
            const template = await editRecurringTask(recurringTaskId, updates, groupId);
            return mapRecurringTask(template);
        },
        deleteRecurringTask: async (_, { recurringTaskId }, context) => {
```

- [ ] **Step 7: Run the full backend suite**

Run: `cd /Users/eugenelinsangan/crm-proj && npm test`
Expected: PASS — every test file, including the 8 new tests.

- [ ] **Step 8: Commit**

```bash
cd /Users/eugenelinsangan/crm-proj
git add typedefs/recurringTaskTypeDefs.js models/recurringTasks.js models/recurringTasks.test.js resolvers/recurringTaskResolvers.js
git commit -m "feat: add editRecurringTask mutation for in-place template edits"
```

---

### Task 2: Frontend — edit mode in `RecurringTaskFormModal`, flip the department flag

**Files:**
- Modify: `src/lib/featureFlags.ts`
- Modify: `src/lib/queries.ts`
- Modify: `src/components/tasks/RecurringTaskFormModal.tsx`

**Interfaces:**
- Consumes: `editRecurringTask` GraphQL mutation from Task 1 (backend).
- Produces: `RecurringTaskFormModal`'s props gain a new optional `isEditing?: boolean` (default `false`), and its `onCreated` prop is renamed to `onSaved` (now fires after either a create/duplicate or an edit — the old name no longer fit). Task 3 (the page) must be updated to use the new prop names; this task's diff to the modal alone will leave the page uncompiled until Task 3 lands, which is fine — commit order within this plan is sequential per-task, not required to keep the frontend compiling at every intermediate commit within a single task boundary, but Tasks 2 and 3 together must leave it compiling. (If your tooling checks compilation after every commit, do Tasks 2 and 3 in the same session without a compilation-checking gate in between, or fold them into one commit — using your judgment is fine here since this is a two-file rename that must land together to compile.)

- [ ] **Step 1: Flip the feature flag**

In `src/lib/featureFlags.ts`, find:
```ts
/**
 * `RECURRING_TASK_DEPARTMENT` covers RecurringTask.departmentId — which department a
 * template's generated tasks belong to.
 *
 * Verified NOT deployed as of 2026-08-20: `{ recurringTasks { id departmentId } }`
 * returns "Cannot query field", and `addRecurringTask(departmentId:)` returns
 * "Unknown argument". Same hazard as the flags above — an unknown argument fails the
 * whole document, which would break recurring task creation entirely.
 * See BACKEND_RECURRING_DEPARTMENT.md.
 */
export const RECURRING_TASK_DEPARTMENT = false;
```
Change to:
```ts
/**
 * `RECURRING_TASK_DEPARTMENT` covers RecurringTask.departmentId — which department a
 * template's generated tasks belong to.
 *
 * Verified live on 2026-09-04: `{ recurringTasks { id departmentId } }` now returns
 * an UNAUTHENTICATED error rather than a schema-validation error, meaning the field
 * is deployed. Kept as a switch rather than deleted, for the same reason as the flags
 * above — a future backend rollback should flip this back to `false` rather than
 * reverting code.
 */
export const RECURRING_TASK_DEPARTMENT = true;
```

- [ ] **Step 2: Add the `EDIT_RECURRING_TASK` query**

In `src/lib/queries.ts`, find:
```ts
export const ADD_RECURRING_TASK = `
  mutation AddRecurringTask(
    $clientId: ID!
    $clientName: String!
    $taskName: String!
    $taskDescription: String!
    $serviceId: ID!
    $assignedMembers: [ID!]!
    $recurrence: Recurrence!
    $priority: TaskPriority
    ${userArgDecl}
    ${deptArgDecl}
  ) {
    addRecurringTask(
      clientId: $clientId
      clientName: $clientName
      taskName: $taskName
      taskDescription: $taskDescription
      serviceId: $serviceId
      assignedMembers: $assignedMembers
      recurrence: $recurrence
      priority: $priority
      ${userArg}
      ${deptArg}
    ) {
      id taskName recurrence active nextRunAt groupId
    }
  }
`;
// This call also generates the first Task instance immediately — no follow-up call needed.
```
Add this new export directly after it (reuses the same `userArgDecl`/`userArg`/`deptArgDecl`/`deptArg` module-level constants already defined earlier in this file — no new constants needed):
```ts

export const EDIT_RECURRING_TASK = `
  mutation EditRecurringTask(
    $recurringTaskId: ID!
    $clientId: ID
    $clientName: String
    $taskName: String
    $taskDescription: String
    $serviceId: ID
    $assignedMembers: [ID!]
    $recurrence: Recurrence
    $priority: TaskPriority
    ${userArgDecl}
    ${deptArgDecl}
  ) {
    editRecurringTask(
      recurringTaskId: $recurringTaskId
      clientId: $clientId
      clientName: $clientName
      taskName: $taskName
      taskDescription: $taskDescription
      serviceId: $serviceId
      assignedMembers: $assignedMembers
      recurrence: $recurrence
      priority: $priority
      ${userArg}
      ${deptArg}
    ) {
      id taskName recurrence active nextRunAt groupId
    }
  }
`;
// Changes the existing template in place — unlike ADD_RECURRING_TASK, does not generate
// a new task instance and does not touch nextRunAt/lastRunAt/active.
```

- [ ] **Step 3: Add edit mode to `RecurringTaskFormModal`**

In `src/components/tasks/RecurringTaskFormModal.tsx`, find:
```tsx
import { graphqlRequest } from '../../lib/graphql';
import { ADD_RECURRING_TASK } from '../../lib/queries';
```
Change to:
```tsx
import { graphqlRequest } from '../../lib/graphql';
import { ADD_RECURRING_TASK, EDIT_RECURRING_TASK } from '../../lib/queries';
```

Find:
```tsx
export function RecurringTaskFormModal({
  clients,
  services,
  members,
  initial,
  onClose,
  onCreated,
}: {
  clients: Client[];
  services: Service[];
  members: Member[];
  /**
   * Prefills the form from an existing template ("Duplicate").
   *
   * The backend has no editRecurringTask mutation, so an existing template can
   * never gain an admin assignee or a department — duplicating into a new one is
   * the only route. Deliberately does NOT delete the original: an automatic
   * delete that ran after a successful create would leave two templates behind
   * on any failure, and the user can remove the old one deliberately.
   */
  initial?: RecurringTask | null;
  onClose: () => void;
  onCreated: () => void;
}) {
```
Change to:
```tsx
export function RecurringTaskFormModal({
  clients,
  services,
  members,
  initial,
  isEditing = false,
  onClose,
  onSaved,
}: {
  clients: Client[];
  services: Service[];
  members: Member[];
  /**
   * Prefills the form from an existing template — used by both "Duplicate"
   * (isEditing false: always creates a new template, leaves the original
   * untouched — see the isEditing doc below for why this stays a separate
   * action) and "Edit" (isEditing true: changes this template in place).
   */
  initial?: RecurringTask | null;
  /**
   * True when saving should change `initial` in place via editRecurringTask,
   * rather than create a new template via addRecurringTask. Ignored if
   * `initial` is null (there's nothing to edit in that case — the form is
   * always creating). Duplicate is kept as a separate, deliberate action from
   * Edit rather than being replaced by it: sometimes a user wants a second,
   * independent template seeded from an existing one, not a change to the
   * original.
   */
  isEditing?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
```

Find:
```tsx
    setSaving(true);
    setError(null);
    try {
      await graphqlRequest(ADD_RECURRING_TASK, {
        clientId,
        clientName: selectedClient?.clientName ?? '',
        taskName,
        taskDescription,
        serviceId,
        assignedMembers,
        recurrence,
        priority,
        ...(TASK_ASSIGNED_USERS ? { assignedUsers } : {}),
        ...(RECURRING_TASK_DEPARTMENT ? { departmentId } : {}),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create recurring task.');
    } finally {
      setSaving(false);
    }
  }
```
Change to:
```tsx
    setSaving(true);
    setError(null);
    try {
      const fields = {
        clientId,
        clientName: selectedClient?.clientName ?? '',
        taskName,
        taskDescription,
        serviceId,
        assignedMembers,
        recurrence,
        priority,
        ...(TASK_ASSIGNED_USERS ? { assignedUsers } : {}),
        ...(RECURRING_TASK_DEPARTMENT ? { departmentId } : {}),
      };
      if (isEditing && initial) {
        await graphqlRequest(EDIT_RECURRING_TASK, { recurringTaskId: initial.id, ...fields });
      } else {
        await graphqlRequest(ADD_RECURRING_TASK, fields);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEditing
            ? 'Failed to save changes.'
            : 'Failed to create recurring task.',
      );
    } finally {
      setSaving(false);
    }
  }
```

Find:
```tsx
      title={initial ? 'Duplicate Recurring Task' : 'New Recurring Task'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {initial ? 'Create Copy' : 'Create Template'}
          </Button>
        </>
      }
```
Change to:
```tsx
      title={isEditing ? 'Edit Recurring Task' : initial ? 'Duplicate Recurring Task' : 'New Recurring Task'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {isEditing ? 'Save Changes' : initial ? 'Create Copy' : 'Create Template'}
          </Button>
        </>
      }
```

- [ ] **Step 4: Typecheck**

Run: `cd /Users/eugenelinsangan/crm-frontend && npx tsc -b --noEmit`
Expected: errors in `src/pages/RecurringTasks.tsx` only, referencing the now-removed `onCreated` prop — this is expected and resolved by Task 3. Confirm there are no *other* errors (e.g. in the modal file itself) before proceeding.

- [ ] **Step 5: Commit**

```bash
cd /Users/eugenelinsangan/crm-frontend
git add src/lib/featureFlags.ts src/lib/queries.ts src/components/tasks/RecurringTaskFormModal.tsx
git commit -m "feat: add edit mode to RecurringTaskFormModal, enable department field"
```

---

### Task 3: Frontend — Edit button on the Recurring Tasks page

**Files:**
- Modify: `src/pages/RecurringTasks.tsx`

**Interfaces:**
- Consumes: `RecurringTaskFormModal`'s new `isEditing` prop and renamed `onSaved` prop from Task 2.

- [ ] **Step 1: Rename `duplicateOf` state to `formTarget`, add `isEditing` state**

Find:
```tsx
  const [formOpen, setFormOpen] = useState(false);
  // Set when duplicating an existing template — see the modal's `initial` prop
  // for why duplication is the only way to change a template's assignment.
  const [duplicateOf, setDuplicateOf] = useState<RecurringTask | null>(null);
```
Change to:
```tsx
  const [formOpen, setFormOpen] = useState(false);
  // The template being duplicated or edited — see the modal's `initial`/`isEditing`
  // props. Null when creating a fresh template.
  const [formTarget, setFormTarget] = useState<RecurringTask | null>(null);
  const [isEditing, setIsEditing] = useState(false);
```

- [ ] **Step 2: Update the "New Recurring Task" button**

Find:
```tsx
          action={
            <Button icon={<IconPlus className="h-4 w-4" />} onClick={() => {
                setDuplicateOf(null);
                setFormOpen(true);
              }}
            >
              New Recurring Task
            </Button>
          }
```
Change to:
```tsx
          action={
            <Button icon={<IconPlus className="h-4 w-4" />} onClick={() => {
                setFormTarget(null);
                setIsEditing(false);
                setFormOpen(true);
              }}
            >
              New Recurring Task
            </Button>
          }
```

- [ ] **Step 3: Add the Edit button next to Duplicate**

Find:
```tsx
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDuplicateOf(t);
                      setFormOpen(true);
                    }}
                  >
                    Duplicate
                  </Button>
```
Change to:
```tsx
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setFormTarget(t);
                      setIsEditing(true);
                      setFormOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setFormTarget(t);
                      setIsEditing(false);
                      setFormOpen(true);
                    }}
                  >
                    Duplicate
                  </Button>
```

- [ ] **Step 4: Update the modal invocation**

Find:
```tsx
      {formOpen && (
        <RecurringTaskFormModal
          clients={clientsQ.rows}
          services={servicesQ.rows}
          members={members}
          initial={duplicateOf}
          onClose={() => {
            setFormOpen(false);
            setDuplicateOf(null);
          }}
          onCreated={() => templatesQ.refetch()}
        />
      )}
```
Change to:
```tsx
      {formOpen && (
        <RecurringTaskFormModal
          clients={clientsQ.rows}
          services={servicesQ.rows}
          members={members}
          initial={formTarget}
          isEditing={isEditing}
          onClose={() => {
            setFormOpen(false);
            setFormTarget(null);
            setIsEditing(false);
          }}
          onSaved={() => templatesQ.refetch()}
        />
      )}
```

- [ ] **Step 5: Typecheck**

Run: `cd /Users/eugenelinsangan/crm-frontend && npx tsc -b --noEmit`
Expected: clean, no output, exit 0 — this resolves the errors Task 2 left behind.

- [ ] **Step 6: Lint**

Run: `cd /Users/eugenelinsangan/crm-frontend && npm run lint`
Expected: no new warnings on `src/pages/RecurringTasks.tsx` or `src/components/tasks/RecurringTaskFormModal.tsx`.

- [ ] **Step 7: Commit**

```bash
cd /Users/eugenelinsangan/crm-frontend
git add src/pages/RecurringTasks.tsx
git commit -m "feat: add Edit action to the Recurring Tasks page"
```

---

### Task 4: Live end-to-end verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Backend — verify `editRecurringTask` directly against a real dev server**

Start the backend dev server for this worktree (`npm run dev`), sign in as a real admin test account, and confirm you have at least one existing recurring task template (create one via the UI or `addRecurringTask` if none exists). Then call the mutation directly:
```bash
curl -s -X POST http://localhost:4000/ \
  -H "Content-Type: application/json" \
  -H "Cookie: <your session cookie>" \
  -d '{"query":"mutation($id: ID!) { editRecurringTask(recurringTaskId: $id, taskName: \"Edited via curl\") { id taskName } }", "variables": {"id": "<a real recurringTaskId>"}}'
```
Expected: a successful response with `taskName: "Edited via curl"`. Then query `recurringTasks` again and confirm: (a) there is still only ONE template with that id (no duplicate was created), (b) `nextRunAt`/`lastRunAt`/`active` are unchanged from before the edit.

- [ ] **Step 2: Backend — verify the recurrence-change behavior**

Note the target template's current `nextRunAt`. Call `editRecurringTask` again, this time changing only `recurrence` to a different value (e.g. `DAILY` → `WEEKLY`). Query `recurringTasks` again and confirm `nextRunAt` is byte-for-byte unchanged from before this call — the new cadence should not have been applied retroactively.

- [ ] **Step 3: Frontend — verify the UI via the Browser pane**

Start the frontend dev server for this worktree pointed at the same backend, sign in, navigate to Recurring Tasks. Confirm: the Department field is now visible in the form (department flag flip); clicking "Edit" on an existing template opens the modal titled "Edit Recurring Task" pre-filled with that template's current values, with a "Save Changes" button; changing the assignee and saving updates the SAME card in the list (no new card appears) and the assignee shown updates; clicking "Duplicate" on the same template still opens a modal titled "Duplicate Recurring Task" with a "Create Copy" button, and saving it creates a genuinely new, separate card while the original is unaffected.

- [ ] **Step 4: Report results**

Summarize what was verified (or any deviation found) directly in the conversation — no separate report file needed for a plan this size.

---
