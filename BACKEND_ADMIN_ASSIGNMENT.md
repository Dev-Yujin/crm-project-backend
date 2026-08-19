# Backend Work Required — Assigning Tasks to Admins

Lets one admin assign work to another admin, and gives each admin a "My Tasks" view.
**The entire frontend is built and merged**, behind the `TASK_ASSIGNED_USERS` flag in
`src/lib/featureFlags.ts`. Flip that to `true` once this ships.

| # | Change | Type |
|---|---|---|
| 1 | `Task.assignedUsers` | `[ID!]!` (default `[]`) |
| 2 | `RecurringTask.assignedUsers` | `[ID!]!` (default `[]`) |
| 3 | `addTask` / `editTask` / `addRecurringTask` args | `[ID!]` |
| 4 | Mirror both to Firebase | **required — see §5** |

> **Status (checked 2026-08-19):** not deployed. `{ tasks { id assignedUsers } }`
> returns `Cannot query field "assignedUsers"`. Re-check with:
>
> ```bash
> curl -s -X POST "$VITE_GRAPHQL_URL" -H 'Content-Type: application/json' \
>   -d '{"query":"{ tasks { id assignedUsers } }"}'
> ```
>
> `UNAUTHENTICATED` = deployed. `Cannot query field` = not yet.

---

## 1. Why a new field, not `assignedMembers`

Admins and members are **different identity spaces**:

| | Admin | Member |
|---|---|---|
| Entity | `GroupUser` | `Member` |
| Id | `id` — Supabase user UUID | `uuid` — CRM roster id |
| Auth | Supabase session | member JWT |
| Store | Postgres (`auth.users`) | CRM roster |

`assignedMembers: [ID!]!` holds member uuids. Putting a Supabase user id in there
would collide with an unrelated id space: `tasksForMember` would start matching
admins, member notifications (`member_<uuid>`) would be sent to ids that aren't
members, and the Members page would render assignees it can't resolve.

So: a second list. A task may have members, admins, or both — assignment is a union,
not a choice.

---

## 2. Schema

```graphql
type Task {
  # …existing fields unchanged…

  "Admin (Supabase user) ids assigned to this task. Separate id space from
   assignedMembers, which holds member uuids. A task may have both."
  assignedUsers: [ID!]!
}

type RecurringTask {
  # …existing fields unchanged…
  assignedUsers: [ID!]!
}

type Mutation {
  addTask(…existing args…, assignedUsers: [ID!]): Task
  editTask(…existing args…, assignedUsers: [ID!]): Task
  addRecurringTask(…existing args…, assignedUsers: [ID!]): RecurringTask
}
```

**Non-null list, nullable argument.** Reads should always return a list (`[]`, never
`null`) so clients can call `.includes()` without a guard. The *arguments* stay
nullable so they can be omitted — see the partial-update rule below.

### Existing rows

`assignedMembers` is currently `[ID!]!` and required on `addTask`. Once a task can be
assigned to an admin alone, **`assignedMembers` should accept an empty array** rather
than erroring. The frontend already enforces "at least one assignee across both lists";
the backend shouldn't require a member specifically.

---

## 3. Resolvers

**`addTask` / `addRecurringTask`** — persist as given; default `[]` when omitted.

**`editTask`** — same partial-update contract as `liveLink`/`source`
(see `LIVE_LINK_SOURCE_INTEGRATION.md`): argument **omitted** leaves the stored value
alone; argument **provided** replaces the list wholesale. Passing `[]` clears all admin
assignees. This matters — `editTask` is called from several places that send only
`{ taskId, statusId }`, and those must not wipe assignment.

**Validation.** Every id must be a `GroupUser` in the **caller's group**. Reject
otherwise — without this check an admin could assign a task to a user in another
tenant, and that user's My Tasks would surface a task from a group they can't see.
Deduplicate the list.

**Notifications.** The existing task-assigned notification goes to `member_<uuid>`.
Admin recipients use the **`user_<id>`** key (`userKey` in `src/lib/notifications.ts`).
If assignment notifications are sent server-side, mirror that convention; if they're
client-side today, nothing to do — the frontend already handles it.

---

## 4. Persistence

```sql
ALTER TABLE tasks           ADD COLUMN assigned_users UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE recurring_tasks ADD COLUMN assigned_users UUID[] NOT NULL DEFAULT '{}';
```

`NOT NULL DEFAULT '{}'` backfills existing rows as empty, so nothing needs migrating
and reads never return null. Consider a GIN index only if you later add a
server-side `tasksForUser` query (§6); the current client-side filter doesn't need one.

---

## 5. ⚠️ Mirror `assignedUsers` to Firebase — the step that makes it visible

**The UI reads tasks from Firebase, not GraphQL.** `GET_TASKS` is declared but never
called; every task rendered comes from the RTDB mirror via `useRealtimeTasks` →
`mapTask` (`src/lib/realtime.ts`). The frontend never writes it, so the backend is the
only writer.

The path is a **flat top-level collection filtered by `groupId`** — not a nested
per-group path:

```jsonc
// /tasks/{taskId}
{
  "taskName": "…",
  "groupId": "…",
  "assignedMembers": { … },
  "assignedUsers": ["<supabase-user-uuid>", …]   // new
}
```

Without this, `addTask` will succeed and **My Tasks will always be empty** — the field
exists in Postgres but never reaches the client.

`RecurringTask` is **not** mirrored — the frontend fetches those over GraphQL
(`GET_RECURRING_TASKS`), so returning `assignedUsers` there is sufficient.

---

## 6. Optional: a `tasksForUser` query

Not required. The frontend filters the mirror client-side in
`src/hooks/useMyAdminWork.ts`, which keeps My Tasks live with no extra round-trip.

If you'd rather push it server-side, mirroring the existing member query:

```graphql
tasksForUser(userId: ID!): [Task!]!   # scoped to the caller's group
```

The hook is written so only its tasks half needs swapping — callers don't change.
Worth doing only if the mirror grows large enough that client-side filtering hurts.

---

## 7. Acceptance checklist

- [ ] `addTask` with `assignedUsers` returns them populated
- [ ] `addTask` omitting it returns `[]`, not `null`
- [ ] `addTask` with `assignedMembers: []` and one `assignedUsers` entry succeeds
- [ ] `editTask` updating only `statusId` leaves `assignedUsers` intact
- [ ] `editTask` with `assignedUsers: []` clears them
- [ ] A user id from another group is rejected
- [ ] Pre-existing tasks return `[]` rather than erroring
- [ ] `recurringTasks` returns `assignedUsers`
- [ ] **`/tasks/{id}.assignedUsers` appears in Firebase after a create and an edit**
