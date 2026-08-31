# Attachment Submit Gate, In-Page Viewer, and Storage Usage Breakdown — Design

## Problem

Three follow-ups to the just-shipped R2 task-attachment feature:

1. The "move to Submitted" gate only checks `liveLink`, ignoring the new attachment field — a
   task with a file but no link can't be submitted, even though it now has legitimate proof of
   work attached.
2. Viewing an attachment opens a new browser tab via a signed URL. The user wants it to stay
   in-page instead.
3. The Billing page shows a single "X GB of Y GB" line. The user wants a breakdown by file
   category (images / PDFs / spreadsheets) as a pie chart, and wants the numbers to stay current
   without a manual page refresh.

## Part 1 — Submit gate: liveLink OR attachment

The shared gate (`if (task && !task.liveLink) { setError(LIVE_LINK_REQUIRED_MESSAGE); return; }`)
appears at 5 call sites: `src/pages/Tasks.tsx`, `src/pages/MyTasks.tsx`,
`src/components/tasks/TaskDetailModal.tsx`, `src/components/member/MemberTaskModal.tsx`,
`src/components/member/MemberTasksView.tsx`. Each becomes:

```ts
if (task && !task.liveLink && !task.attachment) {
  setError(LIVE_LINK_REQUIRED_MESSAGE); // message text updated, see below
  return;
}
```

`LIVE_LINK_REQUIRED_MESSAGE` (`src/components/tasks/statusDisplay.tsx`) changes from `'Set a Live
Link before moving this task to Submitted.'` to `'Set a Live Link or attach a file before moving
this task to Submitted.'`. The constant's name stays as-is — renaming it would touch all 5 import
sites for no behavioral benefit. Still gated inside the existing `TASK_LINK_FIELDS` conditional at
each call site, unchanged: when that flag is off, this gate — attachment-aware or not — is skipped
entirely, matching current behavior.

## Part 2 — In-page attachment viewer

`TaskAttachmentField`'s `handleView` currently calls `taskAttachmentUrl` then `window.open`. It
instead sets a `previewing: boolean` state; when true, a new `AttachmentPreviewCard` component
renders as a `<Modal>` (reusing the existing `src/components/ui/Modal.tsx`, the same component
`ConfirmDialog` and `TrialPopup` already use — `open`, `onClose`, `title`, `children`, `footer`).

`AttachmentPreviewCard` receives the `attachment` object and fetches `taskAttachmentUrl` itself on
open (loading state while the signed URL resolves). Once resolved, content depends on
`attachment.contentType`:

- `image/jpeg`, `image/png`, `image/gif`, `image/webp` → `<img src={url} className="max-h-[70vh]
  w-full object-contain" />`.
- `application/pdf` → `<iframe src={url} className="h-[70vh] w-full" />` — relies on the browser's
  native PDF viewer, no library.
- `text/csv`, `application/vnd.ms-excel`,
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` → no inline render. Shows the
  filename, formatted size, and "Preview isn't available for this file type." with a Download
  button.

Every content type gets a Download button in the modal's footer (`<a href={url} download
={attachment.filename}>`), not just the spreadsheet fallback — the signed URL is short-lived
(5-minute expiry, unchanged from the existing `createDownloadUrl`) so there's no meaningful
exposure difference between "open inline" and "offer as a download link" for the same URL.

`handleView`'s old fetch-then-`window.open` logic, and the popup-blocking workaround fixed in the
final review, are deleted entirely — nothing async happens before the modal opens, so there's no
user-gesture-window problem to work around anymore.

## Part 3 — Storage usage breakdown (pie chart, adaptive units, polling)

### Categories

Three buckets, computed from `attachment.contentType`:
- **Images**: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- **PDFs**: `application/pdf`
- **Spreadsheets**: `text/csv`, `application/vnd.ms-excel`,
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- **Free**: `billing.limits.storageGb × 1024³ − (images + pdfs + spreadsheets)`, floored at 0.

### Backend: new query, computed live (not from the Postgres ledger)

`group_storage.bytes_used` is a single running total — it has no per-category breakdown, and
adding parallel per-category counters there would risk drifting out of sync with the real total
over time (two numbers to keep consistent instead of one). Instead, a new query aggregates
directly from Firebase, the source of truth for each task's `attachment.contentType`/`sizeBytes`:

```graphql
type StorageBreakdown {
  imagesBytes: Float!
  pdfBytes: Float!
  spreadsheetsBytes: Float!
}

type Query {
  taskStorageBreakdown: StorageBreakdown!
}
```

Resolver: `requireCallerGroupId`, then reads every task for that group (reusing
`getAllTasks(groupId)` from `models/task.js`, the same function `Query.tasks` already uses) and
sums `attachment.sizeBytes` into the three buckets by `attachment.contentType`. A task with no
attachment contributes nothing. This is an O(tasks-in-group) scan on each call — acceptable for a
page that's viewed occasionally and not in a hot request path; no new Postgres schema, and always
consistent with what `taskAttachmentUrl`/the attachment UI actually shows, since it reads the exact
same records.

### Frontend: inline SVG pie chart, adaptive byte formatting, polling

- **`formatSize(bytes): string`** — the byte→"1.2 KB"/"3.4 MB"/"5.6 GB" formatter already written
  once for individual files in `TaskAttachmentField.tsx`, extracted to a shared
  `src/lib/formatSize.ts` and imported everywhere a byte count renders: the existing "X of Y GB
  used" line, the new pie chart's legend, and `TaskAttachmentField`'s own per-file size (updated to
  import rather than keep its private copy).
- **Chart**: hand-rolled inline SVG donut (no new dependency — nothing in this repo pulls in a
  charting library yet), four `<path>` arc segments (Images/PDFs/Spreadsheets/Free) computed from
  the four byte values, plus a legend row per category showing its formatted size and percentage
  of the plan's total quota.
- **Polling**: `Billing.tsx` gains a `useEffect` that calls `refetch()` (from `useBilling()`) and
  re-fetches `taskStorageBreakdown` every 15 seconds while the page is mounted, cleared on unmount.
  This is polling, not a push subscription — the app has no GraphQL subscription/websocket layer
  for Postgres-backed data (Tasks/Clients get real-time behavior via a separate Firebase mirror;
  billing data has no equivalent and adding one is out of scope here). 15s keeps the page feeling
  current without adding meaningful load.

## Testing

Backend: no new pure logic to unit-test (the breakdown resolver is a live Firebase read +
aggregation, same "needs a live connection" category as the rest of this app's resolvers — no test
harness convention exists for that here). Frontend: no test framework (established convention).
Manual verification: submit a task with only an attachment (no live link) and confirm it's now
allowed; submit a task with neither and confirm the (updated) error message; view an image, a PDF,
and a CSV/Excel attachment and confirm each renders the right content in-page with no new tab
opened; confirm the Download button works for all three; upload files across all three categories
and confirm the pie chart's slices and legend numbers match; leave the Billing page open across an
upload done on another tab/device and confirm the numbers update within ~15s without a manual
refresh; confirm a KB-sized total renders as KB, not "0.00 GB".
