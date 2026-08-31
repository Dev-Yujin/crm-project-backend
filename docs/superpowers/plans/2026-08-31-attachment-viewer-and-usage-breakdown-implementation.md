# Attachment Submit Gate, In-Page Viewer, and Storage Usage Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a task be submitted with an attachment as an alternative to a live link, replace the attachment-viewing new-tab flow with an in-page preview card, and add a category-breakdown pie chart (images/PDFs/spreadsheets/free) with adaptive KB/MB/GB formatting and periodic refresh to the Billing page.

**Architecture:** The submit gate becomes a two-condition check (`liveLink` OR `attachment`) at the same 5 existing call sites, using each call site's existing state-tracking pattern (direct prop read for board/table views backed by live data; local state for modals holding a frozen task snapshot). The attachment viewer becomes a `<Modal>`-based card that renders `<img>`/`<iframe>`/a download-only fallback based on content type, replacing the current fetch-then-`window.open` flow entirely. The usage breakdown is a new backend query that aggregates every task's attachment by category live from Firebase (not a new Postgres counter — avoids a second number that could drift from the existing ledger), rendered as a hand-rolled inline SVG donut chart on the frontend, refreshed via polling since this app has no live-subscription layer for Postgres-backed data.

**Tech Stack:** Node/Express/Apollo Server/Postgres/Firebase (crm-proj); React 19/TypeScript (crm-frontend). No new dependencies in either repo — the pie chart is hand-rolled SVG, matching this app's existing no-chart-library convention.

## Global Constraints

- Category buckets: Images (`image/jpeg`, `image/png`, `image/gif`, `image/webp`), PDFs (`application/pdf`), Spreadsheets (`text/csv`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
- `taskStorageBreakdown` is computed live from Firebase task records on every call (via the existing `getAllTasks(groupId)`), not from a new Postgres column — the existing `group_billing`/`group_storage` ledger stays the single source of truth for the plan-quota total; this is a separate, independently-computed view for the pie chart's relative proportions.
- The "Free" pie slice is computed as `billing.limits.storageGb × 1024³ − (imagesBytes + pdfBytes + spreadsheetsBytes)`, floored at 0 — deliberately derived from the same live-scanned numbers as the other three slices (not from `billing.storageBytesUsed`), so the four slices always sum to exactly 100% of the chart even if it drifts very slightly from the ledger-sourced "X of Y used" line elsewhere on the page.
- Byte formatting is adaptive (B/KB/MB/GB) everywhere a byte count renders — no field should ever show "0.00 GB" for a small file.
- The Billing page polls every 15 seconds while mounted (both `billing` and the breakdown), stopped on unmount. This is polling, not a push subscription — no GraphQL subscription/websocket layer exists in this app for Postgres-backed data.
- The attachment preview card's Download button works for every content type, not just the non-previewable fallback case.
- Spec: `docs/superpowers/specs/2026-08-31-attachment-viewer-and-usage-breakdown-design.md`.

---

## Task 1: `taskStorageBreakdown` backend query

**Files:**
- Modify: `crm-proj/typedefs/taskTypeDefs.js`
- Modify: `crm-proj/resolvers/taskResolvers.js`

**Interfaces:**
- Consumes: `getAllTasks(groupId)` (existing, from `models/task.js` — already imported in `resolvers/taskResolvers.js`), `requireCallerGroupId` (existing, already imported).
- Produces: `taskStorageBreakdown: StorageBreakdown!` GraphQL query, returning `{ imagesBytes, pdfBytes, spreadsheetsBytes }` (all `Float!`, matching `Billing.storageBytesUsed`'s existing `Float` choice for the same overflow reason). Consumed by frontend Task 4's query string.

- [ ] **Step 1: Add the GraphQL type and query**

In `crm-proj/typedefs/taskTypeDefs.js`, add near the top (after the existing `TaskAttachment`/`UploadTarget` types):

```graphql
  type StorageBreakdown {
    imagesBytes: Float!
    pdfBytes: Float!
    spreadsheetsBytes: Float!
  }
```

Add to the existing `type Query { ... }` block:

```graphql
    taskStorageBreakdown: StorageBreakdown!
```

- [ ] **Step 2: Add the resolver**

In `crm-proj/resolvers/taskResolvers.js`, add these category sets near the top of the file (alongside the existing `mapSubmission`/`mapAttachment` helpers):

```js
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const SPREADSHEET_TYPES = new Set([
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
```

Add to the `Query` object:

```js
        taskStorageBreakdown: async (_, __, context) => {
            const groupId = requireCallerGroupId(context);
            const tasks = await getAllTasks(groupId);

            let imagesBytes = 0;
            let pdfBytes = 0;
            let spreadsheetsBytes = 0;

            for (const task of tasks) {
                const attachment = task.attachment;
                if (!attachment) continue;

                if (IMAGE_TYPES.has(attachment.contentType)) {
                    imagesBytes += attachment.sizeBytes;
                } else if (attachment.contentType === 'application/pdf') {
                    pdfBytes += attachment.sizeBytes;
                } else if (SPREADSHEET_TYPES.has(attachment.contentType)) {
                    spreadsheetsBytes += attachment.sizeBytes;
                }
            }

            return { imagesBytes, pdfBytes, spreadsheetsBytes };
        },
```

Note: `getAllTasks` is scoped by `requireGroup` in its one existing caller (`Query.tasks`), but the function itself just takes a `groupId` string — it works identically when called with the groupId `requireCallerGroupId` returns (covers both admin and member callers), so no change to `models/task.js` is needed.

- [ ] **Step 3: Verify it compiles and existing tests still pass**

Run: `npm test`
Expected: PASS (existing suite unaffected — this resolver needs a live Firebase connection to test end-to-end, covered by manual verification, not a new automated test, matching this repo's established convention for Firebase-backed resolvers)

- [ ] **Step 4: Commit**

```bash
git add typedefs/taskTypeDefs.js resolvers/taskResolvers.js
git commit -m "feat: add taskStorageBreakdown query"
```

---

## Task 2: Shared `formatSize` utility

**Files:**
- Create: `crm-frontend/src/lib/formatSize.ts`
- Modify: `crm-frontend/src/components/tasks/TaskAttachmentField.tsx`

**Interfaces:**
- Produces: `formatSize(bytes: number): string` — e.g. `"512 B"`, `"1.2 KB"`, `"3.4 MB"`, `"5.6 GB"`. Consumed by this task's own updated call site, and later by Tasks 7 and 8 (the pie chart legend and the Billing page's usage line).

- [ ] **Step 1: Extract the utility**

`crm-frontend/src/lib/formatSize.ts`:

```ts
// Adaptive byte formatting — used anywhere a file or storage size renders, so a
// small file never shows as "0.00 GB" and a large total never shows as an
// unwieldy number of bytes.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
```

(This adds a GB tier the old private copy in `TaskAttachmentField.tsx` didn't have — that copy only ever needed to format up to the 100MB per-file cap, but the Billing page's totals can reach tens of GB.)

- [ ] **Step 2: Update `TaskAttachmentField.tsx` to use it**

In `crm-frontend/src/components/tasks/TaskAttachmentField.tsx`, remove the private `formatSize` function (currently defined right after `MAX_FILE_SIZE_BYTES`):

```ts
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

Add an import instead:

```ts
import { formatSize } from '../../lib/formatSize';
```

The rest of the file (the `formatSize(attachment.sizeBytes)` call site) is unchanged — same function name, same signature.

- [ ] **Step 3: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 4: Commit**

```bash
git add src/lib/formatSize.ts src/components/tasks/TaskAttachmentField.tsx
git commit -m "refactor: extract formatSize into a shared utility"
```

---

## Task 3: Submit gate — liveLink OR attachment

**Files:**
- Modify: `crm-frontend/src/components/tasks/statusDisplay.tsx`
- Modify: `crm-frontend/src/pages/Tasks.tsx`
- Modify: `crm-frontend/src/pages/MyTasks.tsx`
- Modify: `crm-frontend/src/components/member/MemberTasksView.tsx`
- Modify: `crm-frontend/src/components/tasks/TaskDetailModal.tsx`
- Modify: `crm-frontend/src/components/member/MemberTaskModal.tsx`

**Interfaces:**
- Consumes: `Task.attachment` (existing field), `TaskAttachmentField`'s `onChanged?: (attachment: Task['attachment']) => void` prop (existing, currently wired to a no-op in the two modals — this task finally gives it a real purpose).

Three of these five call sites read `task.liveLink` directly from data that's already live (a Firebase-backed `tasks` array that updates on its own). The other two are modals holding `task` as a frozen prop, which already track `liveLink` via a local `localLiveLink` state for exactly this reason — this task adds the same treatment for `attachment`.

- [ ] **Step 1: Update the shared message**

In `crm-frontend/src/components/tasks/statusDisplay.tsx`, change:

```ts
export const LIVE_LINK_REQUIRED_MESSAGE =
  'Set a Live Link before moving this task to Submitted.';
```

to:

```ts
export const LIVE_LINK_REQUIRED_MESSAGE =
  'Set a Live Link or attach a file before moving this task to Submitted.';
```

- [ ] **Step 2: Update the two direct-read call sites**

In `crm-frontend/src/pages/Tasks.tsx`, change:

```ts
      if (task && !task.liveLink) {
        setActionError(LIVE_LINK_REQUIRED_MESSAGE);
        return;
      }
```

to:

```ts
      if (task && !task.liveLink && !task.attachment) {
        setActionError(LIVE_LINK_REQUIRED_MESSAGE);
        return;
      }
```

In `crm-frontend/src/pages/MyTasks.tsx`, the same change to the same shaped block (`if (task && !task.liveLink) { setActionError(LIVE_LINK_REQUIRED_MESSAGE); return; }` → add `&& !task.attachment`).

- [ ] **Step 3: Update the third direct-read call site**

In `crm-frontend/src/components/member/MemberTasksView.tsx`, the same change:

```ts
      if (task && !task.liveLink) {
        setActionError(LIVE_LINK_REQUIRED_MESSAGE);
        return;
      }
```

becomes:

```ts
      if (task && !task.liveLink && !task.attachment) {
        setActionError(LIVE_LINK_REQUIRED_MESSAGE);
        return;
      }
```

- [ ] **Step 4: Add local attachment tracking to `TaskDetailModal.tsx`**

In `crm-frontend/src/components/tasks/TaskDetailModal.tsx`, find:

```tsx
  // Same reason: the Submitted gate below has to see a link saved in this
  // session, and `task` is a snapshot that never re-syncs while the modal is open.
  const [localLiveLink, setLocalLiveLink] = useState(task.liveLink);
```

Add directly below it:

```tsx
  // Same reason, for the attachment half of the same gate.
  const [localAttachment, setLocalAttachment] = useState(task.attachment);
```

Find the gate itself:

```tsx
    if (statusId && isSubmittedStatus(statuses, statusId) && TASK_LINK_FIELDS && !localLiveLink) {
      setError(LIVE_LINK_REQUIRED_MESSAGE);
      return;
    }
```

Change to:

```tsx
    if (statusId && isSubmittedStatus(statuses, statusId) && TASK_LINK_FIELDS && !localLiveLink && !localAttachment) {
      setError(LIVE_LINK_REQUIRED_MESSAGE);
      return;
    }
```

Find the `TaskAttachmentField` render:

```tsx
            <TaskAttachmentField
              task={task}
              currentUserIdentity={`admin:${user.id}`}
              isAdmin
              onChanged={() => onChanged?.()}
            />
```

Change `onChanged` to actually update the new local state (still also calling the modal's own `onChanged` prop, unchanged from before):

```tsx
            <TaskAttachmentField
              task={task}
              currentUserIdentity={`admin:${user.id}`}
              isAdmin
              onChanged={(attachment) => {
                setLocalAttachment(attachment);
                onChanged?.();
              }}
            />
```

- [ ] **Step 5: Add local attachment tracking to `MemberTaskModal.tsx`**

In `crm-frontend/src/components/member/MemberTaskModal.tsx`, the same three changes: add `const [localAttachment, setLocalAttachment] = useState(task.attachment);` below the existing `localLiveLink` declaration, add `&& !localAttachment` to the gate condition (`if (statusId && isSubmittedStatus(statuses, statusId) && TASK_LINK_FIELDS && !localLiveLink) {` → add `&& !localAttachment`), and update the `TaskAttachmentField` render's `onChanged` from:

```tsx
              onChanged={() => onChanged?.()}
```

to:

```tsx
              onChanged={(attachment) => {
                setLocalAttachment(attachment);
                onChanged?.();
              }}
```

- [ ] **Step 6: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 7: Commit**

```bash
git add src/components/tasks/statusDisplay.tsx src/pages/Tasks.tsx src/pages/MyTasks.tsx src/components/member/MemberTasksView.tsx src/components/tasks/TaskDetailModal.tsx src/components/member/MemberTaskModal.tsx
git commit -m "feat: allow submitting a task with an attachment in place of a live link"
```

---

## Task 4: `StorageBreakdown` type + query string

**Files:**
- Modify: `crm-frontend/src/types/index.ts`
- Modify: `crm-frontend/src/lib/queries.ts`

**Interfaces:**
- Produces: `StorageBreakdown` interface, `TASK_STORAGE_BREAKDOWN` query string. Consumed by Task 7 (the chart component) and Task 8 (Billing page wiring).

- [ ] **Step 1: Add the type**

In `crm-frontend/src/types/index.ts`, add near the `Billing` interface:

```ts
export interface StorageBreakdown {
  imagesBytes: number;
  pdfBytes: number;
  spreadsheetsBytes: number;
}
```

- [ ] **Step 2: Add the query string**

In `crm-frontend/src/lib/queries.ts`, add near `MY_BILLING`:

```ts
export const TASK_STORAGE_BREAKDOWN = `
  query TaskStorageBreakdown {
    taskStorageBreakdown {
      imagesBytes
      pdfBytes
      spreadsheetsBytes
    }
  }
`;
```

- [ ] **Step 3: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/lib/queries.ts
git commit -m "feat: add StorageBreakdown type and query"
```

---

## Task 5: `AttachmentPreviewCard` component

**Files:**
- Create: `crm-frontend/src/components/tasks/AttachmentPreviewCard.tsx`

**Interfaces:**
- Consumes: `Modal` (existing, `src/components/ui/Modal.tsx` — props `open`, `onClose`, `title`, `children`, `footer`, `size`), `Button` (existing), `TASK_ATTACHMENT_URL` query (existing, from Task 9 of the prior R2 plan), `graphqlRequest` (existing), `formatSize` (Task 2), `TaskAttachment` type (existing).
- Produces: `<AttachmentPreviewCard taskId={string} attachment={TaskAttachment} open={boolean} onClose={() => void} />`, consumed by Task 6.

- [ ] **Step 1: Write the component**

`crm-frontend/src/components/tasks/AttachmentPreviewCard.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { TaskAttachment } from '../../types';
import { graphqlRequest } from '../../lib/graphql';
import { TASK_ATTACHMENT_URL } from '../../lib/queries';
import { formatSize } from '../../lib/formatSize';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Banner';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// In-page attachment viewer — a signed URL is fetched on open and rendered
// according to content type, replacing the old fetch-then-window.open flow
// entirely. Every content type gets a Download button; images and PDFs also
// get an inline preview, everything else (Excel/CSV) gets a "can't preview"
// message instead, since rendering a spreadsheet would need a new library.
export function AttachmentPreviewCard({
  taskId,
  attachment,
  open,
  onClose,
}: {
  taskId: string;
  attachment: TaskAttachment;
  open: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setUrl(null);
      setError(null);
      return;
    }
    let cancelled = false;
    graphqlRequest<{ taskAttachmentUrl: string | null }>(TASK_ATTACHMENT_URL, { taskId })
      .then(({ taskAttachmentUrl }) => {
        if (cancelled) return;
        if (!taskAttachmentUrl) {
          setError('This file is no longer available.');
          return;
        }
        setUrl(taskAttachmentUrl);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not open the file.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  const canPreview = IMAGE_TYPES.has(attachment.contentType) || attachment.contentType === 'application/pdf';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={attachment.filename}
      size="lg"
      footer={
        url && (
          <a href={url} download={attachment.filename}>
            <Button variant="secondary">Download</Button>
          </a>
        )
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      {!error && !url && (
        <div className="flex h-40 items-center justify-center text-sm text-ink/50 dark:text-white/50">
          Loading…
        </div>
      )}
      {!error && url && IMAGE_TYPES.has(attachment.contentType) && (
        <img src={url} alt={attachment.filename} className="max-h-[70vh] w-full object-contain" />
      )}
      {!error && url && attachment.contentType === 'application/pdf' && (
        <iframe src={url} title={attachment.filename} className="h-[70vh] w-full" />
      )}
      {!error && url && !canPreview && (
        <div className="flex h-40 flex-col items-center justify-center gap-1 text-center text-sm text-ink/60 dark:text-white/60">
          <p>Preview isn't available for this file type.</p>
          <p className="text-ink/40 dark:text-white/40">{formatSize(attachment.sizeBytes)}</p>
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 2: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
git add src/components/tasks/AttachmentPreviewCard.tsx
git commit -m "feat: add AttachmentPreviewCard component"
```

---

## Task 6: Wire `AttachmentPreviewCard` into `TaskAttachmentField`

**Files:**
- Modify: `crm-frontend/src/components/tasks/TaskAttachmentField.tsx`

**Interfaces:**
- Consumes: `AttachmentPreviewCard` (Task 5).

- [ ] **Step 1: Replace `handleView` and its trigger with the preview card**

In `crm-frontend/src/components/tasks/TaskAttachmentField.tsx`, add the import:

```ts
import { AttachmentPreviewCard } from './AttachmentPreviewCard';
```

Add a `previewing` state alongside the existing `confirmingRemove` state:

```ts
  const [previewing, setPreviewing] = useState(false);
```

Delete the entire `handleView` function:

```ts
  async function handleView() {
    setError(null);
    // Open the popup synchronously, within the click's user-gesture window —
    // Safari (and Chrome under some settings) blocks window.open once it
    // happens after an await, even if the mutation succeeds. Note: the
    // 'noopener'/'noreferrer' feature string is deliberately omitted here —
    // per spec, 'noreferrer' implies 'noopener', and window.open always
    // returns null when 'noopener' is set, which would make `popup` null
    // unconditionally (not just when actually blocked). Null out `.opener`
    // manually instead to get the same tab-nabbing protection.
    const popup = window.open('', '_blank');
    if (popup) {
      popup.opener = null;
    }
    try {
      const { taskAttachmentUrl } = await graphqlRequest<{ taskAttachmentUrl: string | null }>(
        TASK_ATTACHMENT_URL,
        { taskId: task.id },
      );
      if (!taskAttachmentUrl) {
        popup?.close();
        setError('This file is no longer available.');
        return;
      }
      if (popup) {
        popup.location.href = taskAttachmentUrl;
      } else {
        setError('Your browser blocked the popup — allow popups for this site to view the file.');
      }
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : 'Could not open the file.');
    }
  }
```

The `TASK_ATTACHMENT_URL` import is no longer used in this file — remove it from the import list at the top:

```ts
import {
  REQUEST_TASK_UPLOAD_URL,
  CONFIRM_TASK_ATTACHMENT,
  REMOVE_TASK_ATTACHMENT,
  TASK_ATTACHMENT_URL,
} from '../../lib/queries';
```

becomes:

```ts
import {
  REQUEST_TASK_UPLOAD_URL,
  CONFIRM_TASK_ATTACHMENT,
  REMOVE_TASK_ATTACHMENT,
} from '../../lib/queries';
```

Find the filename button:

```tsx
          <button
            type="button"
            onClick={handleView}
            className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium text-accent-600 hover:underline dark:text-accent-400"
          >
            {attachment.filename}
          </button>
```

Change `onClick` to open the card instead:

```tsx
          <button
            type="button"
            onClick={() => setPreviewing(true)}
            className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium text-accent-600 hover:underline dark:text-accent-400"
          >
            {attachment.filename}
          </button>
```

Render the card near the end of the component's JSX, alongside the existing `ConfirmDialog` (only when `attachment` is set, since the card needs one to show):

```tsx
      {attachment && (
        <AttachmentPreviewCard
          taskId={task.id}
          attachment={attachment}
          open={previewing}
          onClose={() => setPreviewing(false)}
        />
      )}
```

- [ ] **Step 2: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
git add src/components/tasks/TaskAttachmentField.tsx
git commit -m "feat: view attachments in-page instead of opening a new tab"
```

---

## Task 7: `StorageBreakdownChart` component

**Files:**
- Create: `crm-frontend/src/components/billing/StorageBreakdownChart.tsx`

**Interfaces:**
- Consumes: `StorageBreakdown` type (Task 4), `formatSize` (Task 2).
- Produces: `<StorageBreakdownChart breakdown={StorageBreakdown} storageGb={number} />`, consumed by Task 8.

`crm-frontend/src/components/billing/` doesn't exist yet — this is this component's first file in that directory. That's fine; it groups with future billing-only UI rather than crowding `components/ui/` with something Billing-specific.

- [ ] **Step 1: Write the component**

`crm-frontend/src/components/billing/StorageBreakdownChart.tsx`:

```tsx
import type { StorageBreakdown } from '../../types';
import { formatSize } from '../../lib/formatSize';

const GB = 1024 ** 3;

const SLICES = [
  { key: 'imagesBytes', label: 'Images', color: '#3b82f6' },
  { key: 'pdfBytes', label: 'PDFs', color: '#f59e0b' },
  { key: 'spreadsheetsBytes', label: 'Spreadsheets', color: '#10b981' },
] as const;

const FREE_COLOR = '#e2e8f0';

// Converts a list of {value, color} slices (already summing to `total`) into
// SVG <path> arc segments for a donut chart, starting at 12 o'clock and going
// clockwise. Pure geometry, no external charting library.
function buildArcs(values: number[], total: number, radius: number, innerRadius: number) {
  if (total <= 0) return [];
  const cx = radius;
  const cy = radius;
  let angle = -Math.PI / 2;
  const arcs: { d: string; }[] = [];

  for (const value of values) {
    const fraction = value / total;
    if (fraction <= 0) {
      arcs.push({ d: '' });
      continue;
    }
    const nextAngle = angle + fraction * Math.PI * 2;
    const largeArc = fraction > 0.5 ? 1 : 0;

    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(nextAngle);
    const y2 = cy + radius * Math.sin(nextAngle);
    const ix1 = cx + innerRadius * Math.cos(nextAngle);
    const iy1 = cy + innerRadius * Math.sin(nextAngle);
    const ix2 = cx + innerRadius * Math.cos(angle);
    const iy2 = cy + innerRadius * Math.sin(angle);

    const d = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      'Z',
    ].join(' ');

    arcs.push({ d });
    angle = nextAngle;
  }

  return arcs;
}

export function StorageBreakdownChart({
  breakdown,
  storageGb,
}: {
  breakdown: StorageBreakdown;
  storageGb: number;
}) {
  const totalBytes = storageGb * GB;
  const usedBytes = breakdown.imagesBytes + breakdown.pdfBytes + breakdown.spreadsheetsBytes;
  const freeBytes = Math.max(0, totalBytes - usedBytes);

  const values = [breakdown.imagesBytes, breakdown.pdfBytes, breakdown.spreadsheetsBytes, freeBytes];
  const colors = [...SLICES.map((s) => s.color), FREE_COLOR];
  const labels = [...SLICES.map((s) => s.label), 'Free'];

  const radius = 80;
  const innerRadius = 50;
  const arcs = buildArcs(values, totalBytes, radius, innerRadius);

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
      <svg width={radius * 2} height={radius * 2} viewBox={`0 0 ${radius * 2} ${radius * 2}`}>
        {arcs.map((arc, i) =>
          arc.d ? <path key={labels[i]} d={arc.d} fill={colors[i]} /> : null,
        )}
      </svg>
      <ul className="w-full space-y-1.5">
        {values.map((value, i) => (
          <li key={labels[i]} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colors[i] }}
            />
            <span className="min-w-0 flex-1 truncate text-ink/70 dark:text-white/70">
              {labels[i]}
            </span>
            <span className="shrink-0 text-ink/50 dark:text-white/50">
              {formatSize(value)}
              {totalBytes > 0 ? ` (${((value / totalBytes) * 100).toFixed(0)}%)` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
git add src/components/billing/StorageBreakdownChart.tsx
git commit -m "feat: add StorageBreakdownChart component"
```

---

## Task 8: Wire the chart and polling into the Billing page

**Files:**
- Modify: `crm-frontend/src/pages/Billing.tsx`

**Interfaces:**
- Consumes: `StorageBreakdownChart` (Task 7), `TASK_STORAGE_BREAKDOWN` query + `StorageBreakdown` type (Task 4), `formatSize` (Task 2).

- [ ] **Step 1: Fetch the breakdown and add polling**

In `crm-frontend/src/pages/Billing.tsx`, add imports:

```ts
import { StorageBreakdownChart } from '../components/billing/StorageBreakdownChart';
import { TASK_STORAGE_BREAKDOWN } from '../lib/queries';
import { formatSize } from '../lib/formatSize';
import type { StorageBreakdown } from '../types';
```

Add a query alongside the existing `plansData` one:

```ts
  const {
    data: breakdownData,
    refetch: refetchBreakdown,
  } = useQuery<{ taskStorageBreakdown: StorageBreakdown }>(() =>
    graphqlRequest(TASK_STORAGE_BREAKDOWN),
  );
```

Add a polling effect near the existing checkout-confirmation one:

```ts
  // Keeps the usage numbers current without a manual refresh. This is
  // polling, not a push subscription — the app has no GraphQL
  // subscription/websocket layer for Postgres-backed data (Tasks/Clients get
  // that via a separate Firebase mirror; billing data has no equivalent).
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
      refetchBreakdown();
    }, 15000);
    return () => clearInterval(interval);
  }, [refetch, refetchBreakdown]);
```

- [ ] **Step 2: Replace the storage usage line with the chart**

Find:

```tsx
            <p className="mt-1 text-sm text-ink/70 dark:text-white/70">
              {(billing.storageBytesUsed / 1024 ** 3).toFixed(2)} GB of {billing.limits.storageGb} GB storage used
            </p>
```

Replace with:

```tsx
            <p className="mt-1 text-sm text-ink/70 dark:text-white/70">
              {formatSize(billing.storageBytesUsed)} of {formatSize(billing.limits.storageGb * 1024 ** 3)} storage used
            </p>
            {breakdownData?.taskStorageBreakdown && (
              <div className="mt-4">
                <StorageBreakdownChart
                  breakdown={breakdownData.taskStorageBreakdown}
                  storageGb={billing.limits.storageGb}
                />
              </div>
            )}
```

- [ ] **Step 3: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 4: Commit**

```bash
git add src/pages/Billing.tsx
git commit -m "feat: show storage usage breakdown pie chart with live polling"
```

---

## Final Verification

- [ ] Backend: `cd crm-proj && npm test` — full suite passes.
- [ ] Frontend: `cd crm-frontend && npx tsc -b` — clean.
- [ ] Manual verification (per the spec's Testing section): submit a task with only an attachment (no live link) and confirm it's now allowed, in both the admin and member modals and the board/table drag-to-Submitted flows; submit a task with neither and confirm the updated error message; view an image, a PDF, and a CSV/Excel attachment and confirm each renders correctly in-page with no new tab opened, and Download works for all three; upload files across all three categories and confirm the pie chart's slices and legend numbers match; leave the Billing page open and confirm the numbers update within ~15s after an upload done elsewhere; confirm a KB-sized total renders as KB, not "0.00 GB".
