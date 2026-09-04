# Editable recurring tasks

## Problem

Recurring task templates cannot currently be edited. `typedefs/recurringTaskTypeDefs.js` exposes only `addRecurringTask`, `deleteRecurringTask`, `pauseRecurringTask`, and `resumeRecurringTask` — no `editRecurringTask`. The frontend's only workaround is "Duplicate" (`RecurringTaskFormModal`'s `initial` prop): it opens the create form pre-filled from an existing template, but saving always creates a brand-new template and leaves the original completely untouched — including still active on its own schedule. Reassigning a template to a different member/admin, or changing its client/department/anything else, currently means ending up with two templates instead of one changed template.

Separately (discovered during this investigation, not the original ask, but directly relevant): `RECURRING_TASK_DEPARTMENT` in `src/lib/featureFlags.ts` is set to `false`, with a comment dated 2026-08-20 saying the backend didn't yet support `departmentId`. Verified live against production just now (`{ recurringTasks { id departmentId } }` returns `UNAUTHENTICATED`, not a schema-validation error — per this same flag file's own documented interpretation, that means the field is deployed): the backend has supported `departmentId` on `RecurringTask` for a while, but the frontend flag was never flipped, so department has never been settable through the UI at all, not even at creation.

## Goals

- A true edit: change an existing recurring task template in place, with no duplicate left behind.
- Every field the create form already supports becomes editable: client, task name/description, service, assigned members, assigned admins, department, recurrence, priority.
- Editing a template's `recurrence` does not change its already-scheduled next run — the new cadence takes effect starting from the occurrence *after* that (per explicit decision; see Architecture for why this needs no special-casing).
- Keep the existing "Duplicate" action exactly as it is today, unchanged — Edit is a new, separate action alongside it, not a replacement.
- Fix the stale `RECURRING_TASK_DEPARTMENT` flag now that it's confirmed deployed, so department becomes usable on both create and the new edit.

## Non-goals

- No changes to `pauseRecurringTask`/`resumeRecurringTask`/`deleteRecurringTask` — untouched.
- No changes to how the scheduler (`runDueRecurringTasks`) computes or applies `nextRunAt` — the existing computation already produces the desired "new cadence starts after the current scheduled run" behavior for free, as long as edit never touches `nextRunAt` itself (see Architecture).
- No bulk-edit UI, no edit history/audit log — out of scope, not requested.

## Architecture

**Backend — `typedefs/recurringTaskTypeDefs.js`:** add
```graphql
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
```
mirroring `editTask`'s existing shape exactly (`taskId: ID!` plus every other field optional) — every field but `recurringTaskId` becomes optional, and an omitted (`undefined`) argument means "leave this field's stored value unchanged," matching `editTask`'s established convention in this codebase.

**Backend — `models/recurringTasks.js`:** a new `editRecurringTask(recurringTaskId, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, recurrence, priority, assignedUsers, departmentId } = {}, groupId)`, mirroring `editTask`'s model function structure:
1. Load `recurringTasks/${recurringTaskId}`; if it doesn't exist or its `groupId` doesn't match the caller's, throw `"Recurring task not found"` (same error text/shape `deleteRecurringTask`/`setActive` already use for this exact check).
2. Validate only what's actually being changed, reusing validators already imported in this file: `validateMembersExist(assignedMembers, groupId)` if `assignedMembers !== undefined`; `validateUsersExist(assignedUsers, groupId)` if `assignedUsers !== undefined`; `validateServiceForClient(...)` if `clientId !== undefined || serviceId !== undefined` (falling back to the stored value for whichever of the two wasn't passed, same pattern as `editTask`); `validateDepartmentExists(departmentId, groupId)` if `departmentId !== undefined`.
3. Build an `updates` object containing only the keys that were actually passed (skip any `undefined` argument entirely — do not write `undefined` into Firebase). `clientName`, `taskName`, `taskDescription`, `serviceId`, `recurrence`, `priority` pass straight through when present; `assignedMembers`/`assignedUsers` dedupe the same way `addRecurringTask` already does (`[...new Set(...)]`) when present.
4. `await db.ref(`recurringTasks/${recurringTaskId}`).update(updates)` — Firebase's `.update()` is a shallow merge, so `nextRunAt`, `lastRunAt`, `active`, and any field not included in `updates` are left exactly as they were. This is *why* a recurrence change doesn't need special handling to satisfy "keep the old next-run time": nothing about `nextRunAt` is touched by this function at all, and the scheduler (`runDueRecurringTasks`, unmodified by this plan) only reads `recurrence` when it computes the *next* `nextRunAt` after a run fires — so the currently-scheduled run fires on schedule regardless of `recurrence` having changed, and only the *following* computation picks up the new cadence.
5. Return the updated template (re-read, or merge `updates` into the snapshot already in hand — either works; match whichever style `editTask` uses for its own return value).

**Backend — `resolvers/recurringTaskResolvers.js`:** add
```js
editRecurringTask: async (_, { recurringTaskId, ...updates }, context) => {
  const groupId = requireGroup(context);
  const template = await editRecurringTask(recurringTaskId, updates, groupId);
  return mapRecurringTask(template);
},
```
Uses `requireGroup` (admin-only), matching every other mutation already in this resolver file — recurring tasks are already admin-only end to end, no member-facing path exists for them today, and this plan doesn't add one.

**Frontend — `src/lib/featureFlags.ts`:** flip `RECURRING_TASK_DEPARTMENT` to `true`, replacing the stale comment with one noting it was verified live on 2026-09-04 (matching this file's own established convention for how these flags document their verification history — see `TASK_LINK_FIELDS`/`TASK_ASSIGNED_USERS` above it in the same file for the exact style to follow).

**Frontend — `src/components/tasks/RecurringTaskFormModal.tsx`:** gains a way to distinguish "editing template X in place" from "duplicating template X into a new one" from "creating a fresh one" — the component currently only has one signal (`initial`) which today always means "duplicate." Add a second prop, `mode: 'create' | 'duplicate' | 'edit'` (or equivalent — the implementer may find a cleaner shape, e.g. inferring `create`/`duplicate` from whether `initial` is set and adding one new boolean like `isEditing`, as long as the three states stay unambiguous). When `mode === 'edit'`, the form still prefills from `initial` exactly as duplicate does today, but on save it calls the new `editRecurringTask` mutation (passing `recurringTaskId: initial.id` plus only the fields the user actually changed, or simply all current form values — either is correct given the backend accepts a full or partial update identically) instead of `addRecurringTask`. The modal's title/submit-button text should reflect which mode it's in (e.g. "Edit Recurring Task" / "Save Changes" vs. the current "Duplicate" framing) — exact copy is an implementation detail, not specified further here.

**Frontend — `src/pages/RecurringTasks.tsx`:** add a new "Edit" action per row, alongside the existing "Duplicate" action (both remain, per your explicit choice) — "Edit" opens `RecurringTaskFormModal` with `mode: 'edit'` and `initial` set to that row's template; "Duplicate" keeps opening it exactly as it does today, unchanged. On successful edit, refresh the list the same way a successful duplicate/create already does (reuse whatever refetch/callback the modal already exposes via `onCreated` — may want a rename like `onSaved` if the implementer judges the current name is confusing once it also fires after an edit, at their discretion, as long as the actual data-refresh behavior is unchanged).

## Error handling

| Scenario | Behavior |
|---|---|
| `editRecurringTask` called with a `recurringTaskId` that doesn't exist, or belongs to a different group | Throws `"Recurring task not found"` — same text and same check pattern as `deleteRecurringTask`/`pauseRecurringTask`/`resumeRecurringTask` already use |
| `assignedMembers`/`assignedUsers`/`clientId`+`serviceId`/`departmentId` passed but invalid (nonexistent member, user, service-for-client mismatch, or department) | Same validators `addRecurringTask` and `editTask` already use throw their existing errors — no new validation logic, no new error messages |
| A field is omitted from the mutation call | Left untouched in storage — not an error, this is the whole point of the optional-field convention |
| Frontend: edit save fails | Same error-banner pattern `RecurringTaskFormModal` already uses for create/duplicate failures — no new error UI needed |

## Testing

- `models/recurringTasks.test.js` (new — confirmed no test file exists for this module today): `editRecurringTask` updates only the fields passed, leaves everything else (including `nextRunAt`/`lastRunAt`/`active`) untouched; rejects a `recurringTaskId` from another group; validates each of the four validated fields when they're actually being changed and skips validation when they're not passed at all.
- Manual/live verification (per this session's established pattern for UI-facing changes): edit an existing recurring task's assignee and confirm no new template appears in the list and the original's `id` is unchanged; edit `recurrence` on an active template and confirm `nextRunAt` is unchanged immediately after the edit; confirm "Duplicate" still behaves exactly as before (creates a new template, leaves the original alone).
