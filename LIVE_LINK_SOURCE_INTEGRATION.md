# Task `liveLink` / `source` — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md), which still covers setup, auth, and the `graphqlRequest` helper — use that as the base. The actual `ADD_TASK` / `EDIT_TASK` / `GET_TASKS` / `GET_TASKS_FOR_MEMBER` operation strings already include these two fields — see §6 "Tasks" there. This doc is the delta: what the two fields mean, why they're not the same thing as `submission.link`, and a footgun to know about before wiring up the edit form.

## What these are

Two plain optional fields on `Task`:

| Field | Type | Set via |
|---|---|---|
| `liveLink` | `String` (nullable) | `addTask`, `editTask` |
| `source` | `String` (nullable) | `addTask`, `editTask` |

- **`liveLink`** — a URL to a live deliverable, preview, or shared document. Set by whoever **creates** the task, as a reference to work *from*.
- **`source`** — free-text origin of the task, e.g. `"WhatsApp"`, `"Email"`, `"Client call"`. Offer suggestions in the UI but don't constrain it to an enum — teams type their own.

## `liveLink` is not the same thing as `submission.link`

Both are URLs on a `Task`, which makes it tempting to reuse one for the other. Don't — they differ on every axis that matters:

| | `submission.link` | `liveLink` |
|---|---|---|
| Written by | The **assignee** | The **task creator** |
| Written when | On submitting finished work (`submitTask`) | At task creation, editable anytime |
| Means | "Here is the work I completed" | "Here is the doc/preview to work *from*" |
| Cardinality | One per submission | One per task |

Rendering `liveLink` in a "Delivered Files" list, or filtering completed work by it, would show a creator's reference link as if it were a finished deliverable.

## Validation

- Both fields are trimmed server-side; whitespace-only input is stored as `null`, not `""`.
- `liveLink` must start with `http://` or `https://` — any other scheme (`javascript:`, `data:`, etc.) is rejected with an error, since the frontend renders it as a clickable anchor and those schemes are an XSS vector.
- `source` has no format constraint — genuinely free text.
- No length cap beyond your form's own limits — a shared Drive/Notion link can legitimately run past 255 characters.

## The partial-update footgun

`editTask`'s arguments are a partial update: **whether you include an argument at all** is what the backend checks, not just its value.

- Argument **omitted** from the mutation → the stored value is left untouched.
- Argument sent as **`null`** or **`""`** → the stored value is cleared.

This matters specifically because `editTask` is called from a form that edits *other* fields too (`taskName`, `priority`, etc.). If your `EditTask` call always sends `liveLink: formState.liveLink` and `formState.liveLink` defaults to `null`/`""` when that particular form doesn't show a live-link input, you will silently wipe out an existing `liveLink` every time someone edits an unrelated field. Only include `liveLink`/`source` in the mutation variables when the user actually touched that field, or when your form always has both inputs and you genuinely want empty-to-clear behavior.

## TypeScript

These two fields belong on the `Task` interface already in `FRONTEND_INTEGRATION.md` §4:

```ts
liveLink: string | null;
source: string | null;
```

## Verification checklist

Useful if you want to sanity-check the integration yourself, independent of backend testing:

- [ ] `addTask` with both fields returns them populated
- [ ] `addTask` omitting both returns `null` for each (not `""`)
- [ ] `editTask` updating only `taskName` leaves `liveLink` / `source` intact
- [ ] `editTask` with `liveLink: null` clears the stored value
- [ ] `tasks` and `tasksForMember` both return the new fields
- [ ] `liveLink: "javascript:alert(1)"` is rejected
- [ ] Pre-existing tasks (created before this feature shipped) return `null` for both rather than erroring
- [ ] A user in one group cannot read another group's `liveLink` (same group scoping as the rest of `Task` — see [GROUPS_INTEGRATION.md](./GROUPS_INTEGRATION.md))
