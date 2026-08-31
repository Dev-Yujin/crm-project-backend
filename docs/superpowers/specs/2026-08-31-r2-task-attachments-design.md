# Cloud Storage for Task Attachments (R2) — Design

## Problem

Tasks can only be "submitted" with a URL (`liveLink`). There's no way to hand back an
actual file — a design export, a signed PDF, a spreadsheet — without pasting a link to
somewhere else. The product also sells a per-plan storage quota (`storageGb`: 10/50/200
GB on Starter/Business/Scale) that today does nothing; nothing in the app uses storage
at all.

## Scope

Add file-attachment upload/view/remove to Tasks, backed by Cloudflare R2, with usage
metered against the group's plan quota. One attachment slot per task, independent of
the existing `liveLink` field — a task can have a live link, a file attachment, both, or
neither. Out of scope: attachments on Clients or anywhere else, multiple files per task,
meeting-recording storage (a separate, later spec that will build on this one).

## Architecture

- **R2** holds the file bytes only. One bucket (`continuum-crm-files`), objects keyed
  `{groupId}/{taskId}/{uuid}-{filename}`.
- **Firebase** (where all other Task data already lives) holds the attachment's
  metadata as a field on the task record — no new Postgres table for that.
- **Postgres** gets one new table, `group_storage`, tracking each group's running
  `bytes_used` — the same role `group_billing` already plays for plan status. This is
  the only place quota math happens.
- **Uploads go straight from the browser to R2** via a short-lived presigned PUT URL the
  backend issues after validating type/size/quota. The Express server never receives
  the file bytes. Viewing works the same way in reverse: a short-lived presigned GET URL,
  re-issued each time, from a **private** bucket — nothing is ever publicly reachable by
  a bare URL.

## Backend

### Config

New env vars on `crm-proj` (added to `config/`, alongside `config/stripe.js`):
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`. The S3
endpoint is derived, not stored separately: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`.
New dependencies: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (R2 is
S3-API-compatible; these are Cloudflare's own documented client for it).

### `group_storage` table

```sql
CREATE TABLE IF NOT EXISTS group_storage (
  group_id uuid PRIMARY KEY,
  bytes_used bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
)
```
Created via a checked-in idempotent script, matching `scripts/create-group-billing-table.js`.
Row is lazily created on first use — same `getOrCreate` pattern as `group_billing`.

### Allowed types

Explicit MIME allowlist, checked server-side (client also filters the file picker, but
the server is the actual gate): `image/jpeg`, `image/png`, `image/gif`, `image/webp`,
`application/pdf`, `text/csv`, `application/vnd.ms-excel`,
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

Per-file cap: 100MB. This is an internal team tool behind authentication, not a public
upload endpoint — content-type is trusted from the client rather than sniffed from
magic bytes, consistent with the app's existing trust boundary (same level of trust
already placed in, e.g., `avatarBase64`'s client-declared format).

### GraphQL

```graphql
type TaskAttachment {
  filename: String!
  contentType: String!
  sizeBytes: Int!
  uploadedBy: String!   # "admin:<userId>" or "member:<uuid>", same scheme as BACKEND_CONFERENCING.md
  uploadedAt: String!
}

type UploadTarget {
  uploadUrl: String!    # presigned PUT, expires in 5 minutes
  key: String!           # pass back unchanged to confirmTaskAttachment
}

extend type Task {
  attachment: TaskAttachment
}

type Mutation {
  requestTaskUploadUrl(taskId: ID!, filename: String!, contentType: String!, sizeBytes: Int!): UploadTarget!
  confirmTaskAttachment(taskId: ID!, key: String!, filename: String!, contentType: String!, sizeBytes: Int!): Task!
  removeTaskAttachment(taskId: ID!): Task!
}

type Query {
  taskAttachmentUrl(taskId: ID!): String   # presigned GET, expires in 5 minutes; null if no attachment
}
```

- `requestTaskUploadUrl`: caller must be an admin or member of the task's own group —
  same `requireCallerGroupId` scoping `editTask` already uses (there's no per-task
  creator/assignee restriction in this codebase; any admin or member in the group can
  edit any task in it, and this follows that existing model rather than inventing a
  narrower one). Validates `contentType`
  against the allowlist and `sizeBytes` against the 100MB cap, then reads
  `group_storage.bytes_used` and rejects with a clear error if
  `bytes_used + sizeBytes` would exceed `plan.storageGb`. Returns the presigned URL and
  key; nothing is written yet.
- `confirmTaskAttachment`: called after the browser's PUT succeeds. If the task already
  has an attachment, deletes the old R2 object first and adjusts `bytes_used` by the
  *difference* between old and new size (not just adding the new size) — replacing a
  10MB file with a 2MB one should free space, not just add more. Writes the new
  attachment metadata onto the Firebase task record.
- `removeTaskAttachment`: allowed for the uploader or any admin in the group (checked
  against `uploadedBy`). Deletes the R2 object, decrements `bytes_used`, clears the
  Firebase field.
- `taskAttachmentUrl`: re-checks the caller is in the task's group (same visibility rule
  as reading the task itself), then issues a fresh signed GET URL — never cached,
  never returned as part of the task object itself, so a task fetched once and held in
  memory can't leak a permanently-valid link.
- All four mutations fall under the existing `billingLockPlugin` allowlist rules
  automatically — no special-casing needed for trial/lockout behavior, same as every
  other mutation.

A minor, accepted race: two uploads started at nearly the same instant could both pass
the quota check before either confirms, allowing a small overshoot. Not worth locking
for an internal tool at this scale.

## Frontend

- **`TaskAttachmentField.tsx`** — new component, sibling to `TaskLinkFields.tsx`,
  rendered directly below it in the task modals (`TaskFormModal`, `TaskDetailModal`,
  `MemberTaskModal`). Kept as its own component/mutation set on purpose, matching why
  `TaskLinkFields` already is: so its save can't accidentally clobber fields it doesn't
  show.
- **Empty state**: "Attach a file" button opens a file picker with `accept` set to the
  allowed types. Client-side pre-check of type/size before calling
  `requestTaskUploadUrl`, for fast feedback — the server check is still authoritative.
- **Uploading**: `requestTaskUploadUrl` → `PUT` directly to the returned URL with a
  progress indicator → `confirmTaskAttachment`. A quota/type/size rejection from
  `requestTaskUploadUrl` surfaces before any bytes are sent.
- **Set state**: filename, a type icon, and formatted size. Clicking it calls
  `taskAttachmentUrl` and opens the returned URL in a new tab. "Remove" is shown to the
  uploader or any admin.
- **Billing page**: a second usage line next to the existing admin-count metric —
  "X GB of Y GB storage used" — reading `group_storage.bytes_used` against
  `billing.limits.storageGb`.

## Testing

Backend: `vitest` unit tests for the pure pieces — MIME allowlist check, size-cap check,
quota check, and the "replace attachment" byte-delta math — same style as
`utils/avatar.test.js` and `models/billingLogic.js`'s tests. No integration test for the
R2 calls themselves or the mutations (same established convention: needs a live
R2/Postgres/Firebase connection, no test-harness in this repo).

Frontend: no test framework (established convention). Manual verification: upload an
allowed file type under quota (succeeds, appears with correct name/size), upload an
over-quota or disallowed-type file (rejected with a clear message, no bytes sent),
replace an existing attachment (old file's bytes are freed), remove an attachment as
the uploader and as a different admin (both succeed), remove as a different member
(rejected), view an attachment (opens correctly), confirm the Billing page's storage
line updates after each of the above.
