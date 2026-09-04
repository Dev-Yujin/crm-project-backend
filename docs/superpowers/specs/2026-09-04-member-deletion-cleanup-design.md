# Member deletion leaves dangling task/recurring-task assignments

## Problem

`deleteMember` (`models/membersFunction.js:114-128`) is a bare `DELETE FROM members WHERE uuid = $1 AND group_id = $2` — it never checks or cleans up Firebase RTDB `tasks`/`recurringTasks` whose `assignedMembers` array references the deleted member's UUID. This just caused a real production incident: deleting a member left 22 tasks and 5 recurring tasks referencing a UUID that no longer existed in Postgres. Any subsequent edit to those tasks/recurring tasks failed with `Member(s) not found: <uuid>`, because `editTask`/`editRecurringTask`/`addTask`/`addRecurringTask` all re-validate the *entire* `assignedMembers` array via `validateMembersExist` (`models/task.js:19-29`) on every call — not just newly-added members. The incident was fixed manually (a one-off script transferring all 27 references to another member), but nothing prevents it from happening again the next time any member with assignments is deleted.

## Goals

- `deleteMember` never again leaves a dangling `assignedMembers` reference in `tasks` or `recurringTasks`.
- The caller can optionally reassign the departing member's work to another member as part of the same delete call.
- If the caller doesn't specify a reassignment target and the member still has assignments, the delete is refused with a clear, actionable error — never a silent partial cleanup.
- Frontend: deleting a member who has assignments prompts the admin to pick a replacement, in the same delete flow, instead of failing with a raw backend error.

## Non-goals

- No general-purpose "reassign a member's work" mutation independent of delete — not requested, YAGNI.
- No change to how `assignedUsers` (admin assignments, distinct from `assignedMembers`) are handled — members and users are separate assignment types today, and this incident and request are both about members only.
- No UI for bulk member deletion — out of scope, not requested.
- No special-casing for "the group has no other member to reassign to" — see Error Handling.

## Architecture

**Backend — new file `models/memberAssignments.js`** (new, single responsibility: what happens to task/recurring-task assignments when a member is removed):

```js
export const countMemberAssignments = async (uuid, groupId) => {
    // Query tasks and recurringTasks (both indexed by groupId, same as
    // getAllTasksForGroupIndexed / getAllRecurringTasks) and count entries
    // whose assignedMembers includes uuid.
    // Returns { taskCount, recurringTaskCount }.
};

export const reassignMemberAssignments = async (oldUuid, newUuid, groupId) => {
    // Same approach as the incident's manual fix script: for every matching
    // task/recurringTask, replace oldUuid with newUuid in assignedMembers,
    // deduped via Set (newUuid may already be a co-assignee). Batches the
    // updates via db.ref().update(). Returns
    // { tasksTransferred, recurringTasksTransferred }.
};
```

**Backend — `models/membersFunction.js`:** `deleteMember(uuid, groupId, reassignTo = null)`:

1. If `reassignTo` is provided:
   - Reject if `reassignTo === uuid` (`"Cannot reassign to the member being deleted"`).
   - Validate `reassignTo` is a real member in `groupId` via the existing `validateMembersExist` (`models/task.js`).
   - Call `reassignMemberAssignments(uuid, reassignTo, groupId)`.
   - Proceed to delete.
2. Else:
   - Call `countMemberAssignments(uuid, groupId)`.
   - If `taskCount > 0 || recurringTaskCount > 0`, throw a `GraphQLError` with `extensions.code: 'MEMBER_HAS_ASSIGNMENTS'` and `extensions.taskCount` / `extensions.recurringTaskCount` set. The delete does **not** proceed. This follows the same pattern the frontend already consumes for `RATE_LIMITED` and `EMAIL_CREDENTIALS_NOT_CONFIGURED` — `GraphQLRequestError.code` read off `extensions.code`.
   - Otherwise, proceed to delete exactly as today.

**Backend — `typedefs/memberTypeDefs.js`:** `deleteMember(uuid: ID!, reassignTo: ID): Member!` (was `deleteMember(uuid: ID!): Member!`).

**Backend — `resolvers/memberResolvers.js`:** the `deleteMember` resolver passes `reassignTo` from args through to the model function, unchanged otherwise (still `requireGroup`-gated, admin-only, matching every other mutation in this file).

**Frontend — `src/lib/queries.ts`:** `DELETE_MEMBER` gains an optional `$reassignTo: ID` variable, passed through to the mutation.

**Frontend — `src/pages/Members.tsx`:** `handleDelete` first attempts `DELETE_MEMBER` with no `reassignTo`, same as today. If it catches a `GraphQLRequestError` with `code === 'MEMBER_HAS_ASSIGNMENTS'`, the delete confirmation switches into a reassignment mode: shows the counts from the error (`"This member has N tasks and M recurring tasks assigned"`), a dropdown of the group's other members (from the already-loaded `members` list, excluding `deleteTarget`), and a "Reassign & Delete" action that retries `DELETE_MEMBER` with `reassignTo` set to the chosen member's uuid. Any other error is shown in the existing error banner, unchanged.

## Error Handling

| Scenario | Behavior |
|---|---|
| `deleteMember` called with no `reassignTo`, member has zero assignments | Deletes exactly as today |
| `deleteMember` called with no `reassignTo`, member has ≥1 task or recurring-task assignment | Throws `GraphQLError` with `extensions.code: 'MEMBER_HAS_ASSIGNMENTS'`, `extensions.taskCount`, `extensions.recurringTaskCount`. No deletion, no partial cleanup. |
| `deleteMember` called with `reassignTo` set to a nonexistent member, or a member in a different group | Throws the existing `validateMembersExist` error (`"Member(s) not found: <uuid>"`), same as any other caller of that validator. No deletion. |
| `deleteMember` called with `reassignTo === uuid` (reassigning to the member being deleted) | Throws `"Cannot reassign to the member being deleted"`. No deletion. |
| `deleteMember` called with a valid `reassignTo` | All matching `tasks`/`recurringTasks` have `assignedMembers` updated (old UUID replaced by new, deduped), then the member is deleted. |
| The group has no other member to reassign to | No special code path — the frontend's reassignment dropdown is simply empty, and the admin must clear assignments manually (via existing task/recurring-task edit screens) before the delete can succeed. Rare enough not to warrant dedicated handling. |
| Frontend: delete fails with `MEMBER_HAS_ASSIGNMENTS` | Confirm dialog switches to reassignment mode (see Architecture) instead of showing a raw error |
| Frontend: delete fails with any other error | Existing error-banner behavior, unchanged |

## Testing

- `models/memberAssignments.test.js` (new — mocked Firebase RTDB, same pattern as `models/recurringTasks.test.js`): `countMemberAssignments` counts across both collections correctly, including a member with assignments in only one collection and a member with none; `reassignMemberAssignments` replaces the UUID in both collections, dedupes when the target is already a co-assignee, and leaves unrelated tasks/recurring tasks untouched.
- `models/membersFunction.test.js`: `deleteMember` — deletes normally when there are no assignments; blocks with `MEMBER_HAS_ASSIGNMENTS` (and correct counts) when there are assignments and no `reassignTo`; reassigns then deletes when `reassignTo` is valid; rejects `reassignTo === uuid`; rejects a `reassignTo` that doesn't exist or belongs to another group.
- Manual/live verification (per this session's established pattern for backend+frontend changes): delete a member with no assignments (succeeds as before); attempt to delete a member with assignments and no reassignment target (blocked, error shown); delete with a reassignment target chosen in the UI and confirm the tasks/recurring tasks now show the new member and no `Member(s) not found` errors occur on subsequent edits.
