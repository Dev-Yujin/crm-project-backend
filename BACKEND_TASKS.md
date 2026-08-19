# Backend Work Required — MDM CRM Notes

Two fields on `Task`. Everything else in *"Notes for MDM CRM created by Eugene"*
is already implemented on the frontend and needs **no backend change**.

| # | Field | Type | Mutations | Blocks |
|---|---|---|---|---|
| 1 | `liveLink` | `String` (nullable) | `addTask`, `editTask` | "Live Link" field on Create New Task (notes, p.4) |
| 2 | `source` | `String` (nullable) | `addTask`, `editTask` | "Source" field on the same form |

Both are plain optional scalars on an existing type. No new types, no new
mutations, no auth or scoping changes.

---

## 1. Why these can't be done on the frontend

Every other request in the notes touches data that already lives in Firebase RTDB
(inquiries, touchpoints, stage colors) or is pure presentation. These two don't:
they're attributes of a `Task`, which is a GraphQL entity.

### `submission.link` is not a substitute

The obvious shortcut is to reuse the existing submission link:

```graphql
submitTask(taskId: ID!, memberUuid: ID!, link: String!, note: String)
# -> Task { submission { link note submittedBy submittedAt } }
```

Don't. They differ on every axis that matters:

| | `submission.link` | `liveLink` (new) |
|---|---|---|
| Written by | The **assignee** | The **task creator** |
| Written when | On submitting finished work | At task creation |
| Means | "Here is the work I completed" | "Here is the doc/preview to work *from*" |
| Cardinality | One per submission | One per task, editable anytime |

Overloading one onto the other would let a creator's reference link masquerade as
a completed deliverable — corrupting the "Delivered Files" list on the Clients page,
which filters on submissions.

A Firebase shim keyed by `taskId` was also considered and rejected: unlike a display
color, a live link is real task data that should be exportable, queryable, and
visible to any future API consumer.

---

## 2. Schema changes

```graphql
type Task {
  # …existing fields unchanged…

  "URL to a live deliverable, preview, or shared document. Set by whoever creates
   the task; distinct from submission.link, which the assignee sets on submit."
  liveLink: String

  "Free-text origin of the task, e.g. 'WhatsApp', 'Email', 'Client call'."
  source: String
}

type Mutation {
  addTask(
    clientId: ID!
    clientName: String!
    taskName: String!
    taskDescription: String!
    serviceId: ID!
    assignedMembers: [ID!]!
    dueDate: String
    priority: TaskPriority
    statusId: ID
    departmentId: ID
    liveLink: String   # new
    source: String     # new
  ): Task

  editTask(
    # …existing args unchanged…
    liveLink: String   # new
    source: String     # new
  ): Task
}
```

Both optional, so **every existing client keeps working unchanged** — this is a
backward-compatible additive change and needs no coordinated deploy.

---

## 3. Resolver notes

**`addTask`** — persist both straight through; default to `null` when omitted.

**`editTask`** — this one has a real decision. `editTask` args are all optional and
used as a partial update, so distinguish *absent* from *explicitly null*:

- argument **not provided** → leave the stored value untouched
- argument provided as `null` or `""` → clear the field

If you can't tell the two apart in your resolver (some frameworks collapse both to
`undefined`), treat empty string as the clear signal and document it. The frontend
sends `null` to clear.

**Validation.** Keep it light but don't store garbage:

- Trim whitespace; store `null` rather than `""`.
- For `liveLink`, accept only `http://` or `https://`. Reject other schemes —
  `javascript:` and `data:` URLs would be an XSS vector, since the frontend renders
  this as a clickable anchor.
- No length cap needed beyond your existing column limits; a shared Drive/Notion
  URL can legitimately run past 500 characters, so don't cap at 255.
- `source` is free text — do **not** constrain it to an enum. The form offers
  suggestions but teams type their own.

**Auth / scoping.** Identical to the rest of `addTask` / `editTask`. Per
`FRONTEND_INTEGRATION.md` §6, `addTask` requires a user session and is group-scoped;
`editTask` is a member action. Neither field changes that, and neither should be
readable across groups.

---

## 4. Persistence

Two nullable text columns on the tasks table:

```sql
ALTER TABLE tasks ADD COLUMN live_link TEXT;
ALTER TABLE tasks ADD COLUMN source    TEXT;
```

Nullable with no default, so existing rows backfill as `NULL` and no migration
of existing data is needed. No index required — neither field is filtered or
sorted on. (Adjust to your ORM's migration format; the shape is what matters.)

---

## 5. What the frontend will do once this lands

No frontend work is needed from you — this is the contract so you can verify it.

`src/lib/queries.ts` gains the two args and selects the two fields:

```graphql
addTask(… , liveLink: $liveLink, source: $source) {
  id taskName statusId departmentId groupId serviceId assignedMembers priority
  liveLink source
}
```

`GET_TASKS` / `GET_TASKS_FOR_MEMBER` add `liveLink source` to their selection sets,
and `Task` in `src/types/index.ts` gains:

```ts
liveLink: string | null;
source: string | null;
```

Then two form fields appear in `TaskFormModal`, and the tasks table renders
`liveLink` as its own column beside the existing Deliverable column.

---

## 6. Acceptance checklist

- [ ] `addTask` with both fields returns them populated
- [ ] `addTask` omitting both returns `null` for each (not `""`)
- [ ] `editTask` updating only `taskName` leaves `liveLink` / `source` intact
- [ ] `editTask` with `liveLink: null` clears the stored value
- [ ] `tasks` and `tasksForMember` both return the new fields
- [ ] `liveLink: "javascript:alert(1)"` is rejected
- [ ] Pre-existing tasks return `null` for both rather than erroring
- [ ] A user in group A cannot read group B's `liveLink`

---

## 7. One request

Please **re-enable GraphQL introspection**, or publish an SDL dump alongside deploys.
Production currently returns `INTROSPECTION_DISABLED`, so the frontend's schema
knowledge is reverse-engineered from `src/lib/queries.ts` and can silently drift from
what the backend actually exposes. If introspection must stay off in production,
enabling it in staging would be enough.
