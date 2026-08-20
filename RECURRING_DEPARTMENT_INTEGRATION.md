# `RecurringTask.departmentId` — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md) and [RECURRING_TASKS_INTEGRATION.md](./RECURRING_TASKS_INTEGRATION.md), which cover setup, auth, and the recurring task system as a whole — use those as the base. This doc covers one addition: `RecurringTask.departmentId`.

**Status: deployed.** `{ recurringTasks { id departmentId } }` now returns `UNAUTHENTICATED` (needs a session, which is expected), not `Cannot query field "departmentId"`. Safe to flip `RECURRING_TASK_DEPARTMENT` in `src/lib/featureFlags.ts`.

## Why this was missing

`Task.departmentId` already exists and the task form requires it. Recurring task templates had nowhere to store one, so every task the scheduler generated was born without a department — invisible to any department-based filtering or reporting, even though manually created tasks were fully covered. This closes that gap: `RecurringTask` now has its own `departmentId`, and both the immediately-generated first instance and every instance the hourly scheduler generates afterward inherit it.

## Auth & validation

| Operation | Auth | Notes |
|---|---|---|
| `addRecurringTask` `departmentId` arg | **user** (same as the rest of `addRecurringTask`) | validated against the caller's own group |
| `recurringTasks` | **user** | returns `departmentId`, `null` on templates created before this shipped |

- `departmentId` must be one of the **caller's own group's** departments (same catalog as `Task.departmentId`) — an id from another group, or a nonexistent id, is rejected.
- Nullable and optional, same semantics as `Task.departmentId` — omit it and the template (and its generated tasks) simply has no department.
- Same non-cascading caveat as `Task.departmentId`: deleting a department that's in use on a template leaves a dangling id rather than clearing it.
- There is no `editRecurringTask` mutation yet, so no partial-update rule applies here — `departmentId` is only set at creation time via `addRecurringTask`.

## Generated tasks

- **The first `Task` instance**, generated immediately when `addRecurringTask` is called, carries the template's `departmentId`.
- **Every instance the hourly scheduler generates afterward** also carries it — verified live by forcing a template's `nextRunAt` into the past and running the scheduler tick.
- This was verified alongside the template's `assignedUsers` field (see [ADMIN_ASSIGNMENT_INTEGRATION.md](./ADMIN_ASSIGNMENT_INTEGRATION.md)) — both already ride along on every generated instance, template and scheduler paths alike.

## TypeScript

Add to the existing `RecurringTask` interface in `RECURRING_TASKS_INTEGRATION.md`:

```ts
departmentId: string | null;
```

`Task.departmentId` is unchanged — it already exists and is already required on the create/edit task form.

## Operations

Add `departmentId` to the existing `GET_RECURRING_TASKS` / `ADD_RECURRING_TASK` operations (see `RECURRING_TASKS_INTEGRATION.md`):

```ts
const GET_RECURRING_TASKS = `
  query GetRecurringTasks {
    recurringTasks {
      id clientId clientName taskName taskDescription serviceId
      assignedMembers assignedUsers priority recurrence createdBy active lastRunAt nextRunAt departmentId groupId
    }
  }
`;

const ADD_RECURRING_TASK = `
  mutation AddRecurringTask(
    # ...existing variables...
    $departmentId: ID
  ) {
    addRecurringTask(
      # ...existing args...
      departmentId: $departmentId
    ) {
      id taskName recurrence departmentId
    }
  }
`;
```

## Verification checklist

- [x] `addRecurringTask` accepts `departmentId` and returns it
- [x] `recurringTasks` returns `departmentId` (`null` on existing templates)
- [x] A department id from another group (or a nonexistent id) is rejected
- [x] The immediately-generated first task instance carries the template's `departmentId`
- [x] A scheduler-generated instance (forced due, real scheduler tick) carries the template's `departmentId`
- [x] Existing templates still generate tasks without erroring

All verified live against the real database as of this doc's writing — safe to flip the feature flag.
