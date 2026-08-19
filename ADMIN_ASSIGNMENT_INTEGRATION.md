# Task `assignedUsers` (Admin Assignment) — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md), which still covers setup, auth, and the `graphqlRequest` helper — use that as the base. This doc covers `Task.assignedUsers` / `RecurringTask.assignedUsers` — letting one admin assign work to another.

**Status: deployed.** `{ tasks { id assignedUsers } }` now returns `UNAUTHENTICATED` (needs a session, which is expected for `tasks`), not `Cannot query field "assignedUsers"`. Safe to flip `TASK_ASSIGNED_USERS` in `src/lib/featureFlags.ts`.

## Why a separate field, not `assignedMembers`

Admins and members are different identity spaces:

| | Admin | Member |
|---|---|---|
| Entity | `GroupUser` | `Member` |
| Id | `id` — Supabase user UUID | `uuid` — CRM roster id |
| Auth | Supabase session | member JWT |
| Store | Postgres (`auth.users`, via the `groups` table) | CRM roster (`members` table) |

`assignedMembers` holds member uuids — putting a Supabase user id in there would collide with an unrelated id space (`tasksForMember` would start matching admins, etc.). So: a second list. A task may have members, admins, or both — assignment is a union, not a choice. `assignedMembers` no longer requires at least one entry; a task can now be assigned to admins only.

## One important architecture difference from what was speced

The original request assumed Postgres is the primary store for tasks and Firebase is a write-through mirror the backend has to keep in sync. **That's not how this backend is built** — `Task` and `RecurringTask` have always lived directly in Firebase Realtime Database; there is no Postgres `tasks` or `recurring_tasks` table at all. GraphQL resolvers (`tasks`, `tasksForMember`, `recurringTasks`) read straight from the same Firebase records the frontend's `useRealtimeTasks` hook subscribes to.

Practically, this means the "mirror to Firebase" step wasn't a separate implementation task — `assignedUsers` is written to Firebase because that's the *only* place it's written, by both `addTask`/`editTask` and `addRecurringTask`. There's no dual-write consistency risk to worry about, and no delay between a GraphQL mutation completing and the field showing up in the RTDB record the frontend reads live.

## Auth & validation

| Operation | Auth | Notes |
|---|---|---|
| `addTask` / `editTask` `assignedUsers` arg | **user** (same as the rest of `addTask`/`editTask`) | validated against the caller's own group |
| `addRecurringTask` `assignedUsers` arg | **user** | same |

- Every id in `assignedUsers` must be a `GroupUser` (Supabase user) in the **caller's own group** — an id from another group is rejected outright, same as every other cross-reference in this API (services, statuses, departments, members).
- The list is deduplicated server-side.
- **`editTask`'s partial-update rule applies here too** (same as `liveLink`/`source` — see [LIVE_LINK_SOURCE_INTEGRATION.md](./LIVE_LINK_SOURCE_INTEGRATION.md)): omit the argument entirely to leave the stored assignees untouched; send `assignedUsers: []` to explicitly clear them. This matters because `editTask` gets called from places that only touch one field (e.g. `{ taskId, statusId }`) — those calls must not include `assignedUsers` at all, or they'll wipe out the admin assignment.
- No server-side `tasksForUser` query was added — the frontend already filters the Firebase mirror client-side (`useMyAdminWork.ts`), which stays as-is.
- No server-side notification code exists in this backend at all (assignment notifications, if any, are entirely client-side) — nothing changed there.

## TypeScript

Add to the existing `Task` and `RecurringTask` interfaces in `FRONTEND_INTEGRATION.md` / `RECURRING_TASKS_INTEGRATION.md`:

```ts
assignedUsers: string[]; // Supabase user ids — always an array, never null
```

## Operations

Add `assignedUsers` to the existing `ADD_TASK` / `EDIT_TASK` (see `FRONTEND_INTEGRATION.md` §6) and `ADD_RECURRING_TASK` (see `RECURRING_TASKS_INTEGRATION.md`) mutations:

```ts
const ADD_TASK = `
  mutation AddTask(
    # ...existing variables...
    $assignedUsers: [ID!]
  ) {
    addTask(
      # ...existing args...
      assignedUsers: $assignedUsers
    ) {
      id taskName assignedMembers assignedUsers
    }
  }
`;

const EDIT_TASK = `
  mutation EditTask(
    # ...existing variables...
    $assignedUsers: [ID!]
  ) {
    editTask(
      # ...existing args...
      assignedUsers: $assignedUsers
    ) {
      id taskName assignedMembers assignedUsers
    }
  }
`;
```

And add `assignedUsers` to whatever selection set you use for `GET_TASKS` / `GET_TASKS_FOR_MEMBER` / `GET_RECURRING_TASKS` if you want it back from a direct GraphQL read — though since the UI reads tasks from the Firebase mirror rather than `GET_TASKS`, the field showing up in the RTDB record (already true — see verification below) is what actually matters for rendering.

## Verification checklist

- [x] `addTask` with `assignedUsers` returns them populated
- [x] `addTask` omitting it returns `[]`, not `null`
- [x] `addTask` with `assignedMembers: []` and one `assignedUsers` entry succeeds
- [x] `editTask` updating only one field (no `assignedUsers` arg) leaves it intact
- [x] `editTask` with `assignedUsers: []` clears them
- [x] A user id from another group is rejected
- [x] Pre-existing tasks return `[]` rather than erroring
- [x] `recurringTasks` returns `assignedUsers`
- [x] `/tasks/{id}.assignedUsers` and `/recurringTasks/{id}.assignedUsers` appear in Firebase after a create and an edit

All verified live against the real database as of this doc's writing — safe to flip the feature flag.
