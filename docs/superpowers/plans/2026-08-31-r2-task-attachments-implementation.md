# R2 Task Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a task be given a file attachment (image, PDF, Excel, or CSV) stored in Cloudflare R2, alongside its existing `liveLink`, metered against the group's plan storage quota.

**Architecture:** R2 holds file bytes only, keyed `{groupId}/{taskId}/{uuid}-{filename}`, accessed exclusively via short-lived presigned URLs (upload and download) from a private bucket — the Express server never receives file bytes. A new Postgres table `group_storage` tracks each group's running `bytes_used`, checked against `plan.storageGb` before every upload. Attachment metadata (filename, content type, size, uploader, timestamp) lives on the Task's existing Firebase record, matching where every other Task field already lives.

**Tech Stack:** Node/Express/Apollo Server 5 + Postgres + Firebase Realtime Database (crm-proj); React 19/TypeScript (crm-frontend). New dependency: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2's documented S3-compatible client).

## Global Constraints

- Allowed content types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf`, `text/csv`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Per-file cap: 100MB (`104857600` bytes).
- One attachment per task — a new confirmed upload replaces whatever was there, freeing the old file's bytes from the group's quota.
- `requestTaskUploadUrl`/`confirmTaskAttachment`/`removeTaskAttachment`/`taskAttachmentUrl` all require the caller to be an admin or member of the task's own group — the same `requireCallerGroupId` scoping `editTask` already uses. There is no per-task creator/assignee restriction in this codebase.
- `removeTaskAttachment` is additionally allowed only for the original uploader or any admin in the group.
- Content type and declared size are trusted from the client (not sniffed from file bytes) — this is an authenticated internal tool, not a public upload endpoint, matching the trust level already placed in `avatarBase64`.
- Presigned URLs (both upload and download) expire in 5 minutes.
- All new mutations fall under the existing `billingLockPlugin` allowlist automatically — no special-casing needed.
- Spec: `docs/superpowers/specs/2026-08-31-r2-task-attachments-design.md`.

---

## Task 1: `group_storage` table + storage-usage model

**Files:**
- Create: `crm-proj/scripts/create-group-storage-table.js`
- Create: `crm-proj/models/storage.js`

**Interfaces:**
- Produces: `getOrCreateStorageUsage(groupId): Promise<number>` (bytes used, creating the row lazily if missing), `adjustBytesUsed(groupId, deltaBytes): Promise<void>` (adds `deltaBytes`, which may be negative, clamped at 0). Both are used by every later backend task.

This runs DDL against the shared production database — **confirm with the user before running Step 2**, even though it's purely additive (`IF NOT EXISTS`, no existing table touched).

- [ ] **Step 1: Write the migration script**

`crm-proj/scripts/create-group-storage-table.js`:

```js
// One-time setup: creates the group_storage table backing the R2 task-attachments
// feature (see docs/superpowers/specs/2026-08-31-r2-task-attachments-design.md).
// Idempotent — IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/create-group-storage-table.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Creating group_storage table (if missing)...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_storage (
      group_id uuid PRIMARY KEY,
      bytes_used bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const check = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'group_storage'
  `);
  console.log(
    check.rows.length > 0
      ? "Done — group_storage table exists."
      : "Something went wrong — group_storage table was not found after creation.",
  );
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to create group_storage table:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it against the database**

Confirm with the user first. Then:

Run: `node scripts/create-group-storage-table.js`
Expected: `Done — group_storage table exists.`

- [ ] **Step 3: Write `models/storage.js`**

`crm-proj/models/storage.js`:

```js
import { pool } from '../config/supabase.js';

// Reads a group's running storage usage, lazily creating the row (starting at 0
// bytes) the first time this group ever touches storage — same lazy-provision
// pattern as models/billing.js's getOrCreateBilling.
export async function getOrCreateStorageUsage(groupId) {
  const existing = await pool.query('SELECT bytes_used FROM group_storage WHERE group_id = $1', [groupId]);
  if (existing.rows.length > 0) {
    return Number(existing.rows[0].bytes_used);
  }

  const inserted = await pool.query(
    `INSERT INTO group_storage (group_id, bytes_used)
     VALUES ($1, 0)
     ON CONFLICT (group_id) DO NOTHING
     RETURNING bytes_used`,
    [groupId],
  );

  if (inserted.rows.length > 0) {
    return Number(inserted.rows[0].bytes_used);
  }

  // Lost the insert race — a concurrent request created the row first.
  const raced = await pool.query('SELECT bytes_used FROM group_storage WHERE group_id = $1', [groupId]);
  return Number(raced.rows[0].bytes_used);
}

// Adds deltaBytes (may be negative, e.g. when a file is removed or replaced with a
// smaller one) to a group's running total. Clamps at 0 — a delete racing ahead of
// its own create, or accumulated rounding, should never push this negative.
export async function adjustBytesUsed(groupId, deltaBytes) {
  await getOrCreateStorageUsage(groupId);
  await pool.query(
    `UPDATE group_storage
     SET bytes_used = GREATEST(0, bytes_used + $1), updated_at = now()
     WHERE group_id = $2`,
    [deltaBytes, groupId],
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/create-group-storage-table.js models/storage.js
git commit -m "feat: add group_storage table and storage-usage model"
```

---

## Task 2: Attachment validation helpers

**Files:**
- Create: `crm-proj/utils/attachments.js`
- Create: `crm-proj/utils/attachments.test.js`

**Interfaces:**
- Consumes: nothing (pure functions, no DB).
- Produces: `ALLOWED_CONTENT_TYPES` (Set<string>), `MAX_FILE_SIZE_BYTES` (number), `validateContentType(contentType)` (throws `Error` if not allowed), `validateFileSize(sizeBytes)` (throws `Error` if over cap or not a positive integer), `checkStorageQuota(bytesUsed, incomingSizeBytes, storageGbLimit)` (throws `Error` if `bytesUsed + incomingSizeBytes` would exceed the quota). All used by Task 4's resolver.

- [ ] **Step 1: Write the failing tests**

`crm-proj/utils/attachments.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  validateContentType,
  validateFileSize,
  checkStorageQuota,
  MAX_FILE_SIZE_BYTES,
} from './attachments.js';

describe('validateContentType', () => {
  it('accepts an allowed image type', () => {
    expect(() => validateContentType('image/png')).not.toThrow();
  });

  it('accepts an allowed spreadsheet type', () => {
    expect(() => validateContentType('application/vnd.ms-excel')).not.toThrow();
  });

  it('rejects a disallowed type', () => {
    expect(() => validateContentType('application/x-msdownload')).toThrow(/not allowed/i);
  });
});

describe('validateFileSize', () => {
  it('accepts a size at exactly the cap', () => {
    expect(() => validateFileSize(MAX_FILE_SIZE_BYTES)).not.toThrow();
  });

  it('rejects a size one byte over the cap', () => {
    expect(() => validateFileSize(MAX_FILE_SIZE_BYTES + 1)).toThrow(/too large/i);
  });

  it('rejects a non-positive size', () => {
    expect(() => validateFileSize(0)).toThrow();
    expect(() => validateFileSize(-5)).toThrow();
  });
});

describe('checkStorageQuota', () => {
  const oneGb = 1024 ** 3;

  it('allows an upload that fits within the quota', () => {
    expect(() => checkStorageQuota(5 * oneGb, oneGb, 10)).not.toThrow();
  });

  it('allows an upload that exactly fills the quota', () => {
    expect(() => checkStorageQuota(9 * oneGb, oneGb, 10)).not.toThrow();
  });

  it('rejects an upload that would exceed the quota', () => {
    expect(() => checkStorageQuota(9 * oneGb, 2 * oneGb, 10)).toThrow(/quota/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run utils/attachments.test.js`
Expected: FAIL — `Cannot find module './attachments.js'`

- [ ] **Step 3: Write the implementation**

`crm-proj/utils/attachments.js`:

```js
export const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

export function validateContentType(contentType) {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Content type "${contentType}" is not allowed for task attachments.`);
  }
}

export function validateFileSize(sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('File size must be a positive integer number of bytes.');
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File is too large (${sizeBytes} bytes, max ${MAX_FILE_SIZE_BYTES}).`);
  }
}

// storageGbLimit is the plan's storageGb (e.g. 10, 50, 200) — converted here rather
// than at every call site so the GB-to-bytes conversion lives in exactly one place.
export function checkStorageQuota(bytesUsed, incomingSizeBytes, storageGbLimit) {
  const limitBytes = storageGbLimit * 1024 ** 3;
  if (bytesUsed + incomingSizeBytes > limitBytes) {
    throw new Error(
      `This upload would exceed your plan's storage quota (${storageGbLimit}GB). Remove some files or upgrade your plan.`,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run utils/attachments.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add utils/attachments.js utils/attachments.test.js
git commit -m "feat: add task-attachment validation helpers"
```

---

## Task 3: R2 client wrapper

**Files:**
- Create: `crm-proj/config/r2.js`
- Modify: `crm-proj/package.json`

**Interfaces:**
- Produces: `createUploadUrl(key, contentType): Promise<string>`, `createDownloadUrl(key): Promise<string>`, `deleteR2Object(key): Promise<void>`. Used by Tasks 4, 5, 6.

No integration test — same established convention as `config/stripe.js` (needs a live credentialed connection, no test harness in this repo for external services).

- [ ] **Step 1: Add the AWS SDK dependencies**

Run: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

- [ ] **Step 2: Write `config/r2.js`**

`crm-proj/config/r2.js`:

```js
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REQUIRED_ENV_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];

for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    throw new Error(`Missing ${name} environment variable`);
  }
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const URL_TTL_SECONDS = 5 * 60;

// Signs Bucket/Key/ContentType only — deliberately does not include ContentLength,
// which would require the browser's PUT to send an exactly matching Content-Length
// header or fail signature verification. The declared size is instead validated
// separately (see utils/attachments.js) before this URL is ever issued.
export async function createUploadUrl(key, contentType) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn: URL_TTL_SECONDS });
}

export async function createDownloadUrl(key) {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: URL_TTL_SECONDS });
}

export async function deleteR2Object(key) {
  await client.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  }));
}
```

- [ ] **Step 3: Verify the module loads**

Run: `node -e "process.env.R2_ACCOUNT_ID='x';process.env.R2_ACCESS_KEY_ID='x';process.env.R2_SECRET_ACCESS_KEY='x';process.env.R2_BUCKET_NAME='x';import('./config/r2.js').then(() => console.log('OK'))"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add config/r2.js package.json package-lock.json
git commit -m "feat: add R2 client wrapper for presigned URLs"
```

---

## Task 4: `requestTaskUploadUrl` mutation

**Files:**
- Modify: `crm-proj/typedefs/taskTypeDefs.js`
- Modify: `crm-proj/resolvers/taskResolvers.js`

**Interfaces:**
- Consumes: `getOrCreateStorageUsage` (Task 1), `validateContentType`/`validateFileSize`/`checkStorageQuota` (Task 2), `createUploadUrl` (Task 3), `getOrCreateBilling` (existing, from `models/billing.js`).
- Produces: `requestTaskUploadUrl(taskId, filename, contentType, sizeBytes): UploadTarget!` GraphQL mutation, returning `{ uploadUrl, key }`. `key` is consumed by Task 5's `confirmTaskAttachment`.

- [ ] **Step 1: Add the GraphQL types**

In `crm-proj/typedefs/taskTypeDefs.js`, add near the top (after the existing `Submission`/`Revision` types):

```graphql
  type TaskAttachment {
    filename: String!
    contentType: String!
    sizeBytes: Int!
    uploadedBy: ID!
    uploadedAt: String!
  }

  type UploadTarget {
    uploadUrl: String!
    key: String!
  }
```

Then extend the `Task` type (find the existing `type Task { ... }` block) by adding, alongside the existing `liveLink` / `source` / `notes` fields:

```graphql
    attachment: TaskAttachment
```

And add to the existing `type Mutation { ... }` block:

```graphql
    requestTaskUploadUrl(taskId: ID!, filename: String!, contentType: String!, sizeBytes: Int!): UploadTarget!
```

- [ ] **Step 2: Add the resolver**

In `crm-proj/resolvers/taskResolvers.js`, add these imports at the top:

```js
import { validateContentType, validateFileSize, checkStorageQuota } from '../utils/attachments.js';
import { createUploadUrl } from '../config/r2.js';
import { getOrCreateStorageUsage } from '../models/storage.js';
import { getOrCreateBilling } from '../models/billing.js';
import { requireCallerGroupId } from '../utils/requireUser.js';
import { randomUUID } from 'crypto';
```

(`requireCallerGroupId` may already be imported from `../utils/requireUser.js` in this file — if so, add `requireCallerGroupId` to the existing import list instead of a new line.)

Add to the `Mutation` object:

```js
        requestTaskUploadUrl: async (_, { taskId, filename, contentType, sizeBytes }, context) => {
            const groupId = requireCallerGroupId(context);

            validateContentType(contentType);
            validateFileSize(sizeBytes);

            const [bytesUsed, billing] = await Promise.all([
                getOrCreateStorageUsage(groupId),
                getOrCreateBilling(groupId),
            ]);
            checkStorageQuota(bytesUsed, sizeBytes, billing.limits.storageGb);

            const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
            const key = `${groupId}/${taskId}/${randomUUID()}-${safeFilename}`;
            const uploadUrl = await createUploadUrl(key, contentType);

            return { uploadUrl, key };
        },
```

- [ ] **Step 3: Verify it compiles and existing tests still pass**

Run: `npm test`
Expected: PASS (existing suite unaffected — this task adds no new tests of its own; `requestTaskUploadUrl` needs a live DB/R2 connection and is covered by the manual verification steps in the spec instead, same convention as `createCheckoutSession`)

- [ ] **Step 4: Commit**

```bash
git add typedefs/taskTypeDefs.js resolvers/taskResolvers.js
git commit -m "feat: add requestTaskUploadUrl mutation"
```

---

## Task 5: `confirmTaskAttachment` mutation

**Files:**
- Create: `crm-proj/models/taskAttachments.js`
- Modify: `crm-proj/typedefs/taskTypeDefs.js`
- Modify: `crm-proj/resolvers/taskResolvers.js`

**Interfaces:**
- Consumes: `adjustBytesUsed` (Task 1), `deleteR2Object` (Task 3).
- Produces: `getTaskForGroup(taskId, groupId): Promise<object>` and `setTaskAttachment(taskId, groupId, attachment): Promise<object>` from `models/taskAttachments.js`, used by Tasks 5, 6, 7. `confirmTaskAttachment(taskId, key, filename, contentType, sizeBytes): Task!` GraphQL mutation.

- [ ] **Step 1: Write `models/taskAttachments.js`**

`crm-proj/models/taskAttachments.js`:

```js
import { getDatabase } from 'firebase-admin/database';
import { app } from '../config/firebase.js';

const db = getDatabase(app);

// Fetches a task and verifies it belongs to the caller's group — same existence/
// ownership check every task-mutating function in models/task.js already performs
// inline. Kept here as its own helper since every attachment operation needs it.
export async function getTaskForGroup(taskId, groupId) {
    const taskRef = db.ref(`tasks/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
        throw new Error('Task not found');
    }

    return { ref: taskRef, task: { id: taskId, ...snapshot.val() } };
}

// Writes (or clears, if attachment is null) the attachment field on a task, returning
// the full updated task object in the same shape models/task.js's functions return.
export async function setTaskAttachment(taskId, groupId, attachment) {
    const { ref, task } = await getTaskForGroup(taskId, groupId);
    const updated = { ...task, attachment };
    delete updated.id;
    await ref.update({ attachment });
    return { id: taskId, ...updated };
}
```

- [ ] **Step 2: Add the GraphQL mutation**

In `crm-proj/typedefs/taskTypeDefs.js`, add to `type Mutation { ... }`:

```graphql
    confirmTaskAttachment(taskId: ID!, key: String!, filename: String!, contentType: String!, sizeBytes: Int!): Task!
```

- [ ] **Step 3: Add the resolver**

In `crm-proj/resolvers/taskResolvers.js`, add to the imports:

```js
import { getTaskForGroup, setTaskAttachment } from '../models/taskAttachments.js';
import { adjustBytesUsed } from '../models/storage.js';
import { deleteR2Object } from '../config/r2.js';
```

Add a helper near the top of the file, alongside the existing `mapSubmission`/`mapRevision`:

```js
const mapAttachment = (attachment) => attachment && {
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    uploadedBy: attachment.uploadedBy,
    uploadedAt: attachment.uploadedAt,
};
```

Add `attachment: mapAttachment(task.attachment)` to the existing `mapTask` function's returned object (alongside the existing `submission: mapSubmission(task.submission)` line).

Add to the `Mutation` object:

```js
        confirmTaskAttachment: async (_, { taskId, key, filename, contentType, sizeBytes }, context) => {
            const groupId = requireCallerGroupId(context);
            const uploadedBy = context?.user ? `admin:${context.user.id}` : `member:${context.member.uuid}`;

            const { task: existing } = await getTaskForGroup(taskId, groupId);
            const previousSize = existing.attachment?.sizeBytes ?? 0;
            const previousKey = existing.attachment?.key ?? null;

            const attachment = {
                key,
                filename,
                contentType,
                sizeBytes,
                uploadedBy,
                uploadedAt: new Date().toISOString(),
            };

            const updated = await setTaskAttachment(taskId, groupId, attachment);
            await adjustBytesUsed(groupId, sizeBytes - previousSize);

            if (previousKey) {
                await deleteR2Object(previousKey);
            }

            return mapTask(updated);
        },
```

(Note: `attachment.key` is stored in Firebase and returned via `mapTask`'s `mapAttachment`, but `key` is intentionally **not** part of the `TaskAttachment` GraphQL type from Task 4 — it's an internal R2 identifier, not something the client needs. `mapAttachment` already only projects `filename`/`contentType`/`sizeBytes`/`uploadedBy`/`uploadedAt`, so this is automatic — no change needed there.)

- [ ] **Step 4: Verify it compiles and existing tests still pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add models/taskAttachments.js typedefs/taskTypeDefs.js resolvers/taskResolvers.js
git commit -m "feat: add confirmTaskAttachment mutation"
```

---

## Task 6: `removeTaskAttachment` mutation

**Files:**
- Modify: `crm-proj/typedefs/taskTypeDefs.js`
- Modify: `crm-proj/resolvers/taskResolvers.js`

**Interfaces:**
- Consumes: `getTaskForGroup`/`setTaskAttachment` (Task 5), `adjustBytesUsed` (Task 1), `deleteR2Object` (Task 3).
- Produces: `removeTaskAttachment(taskId: ID!): Task!` GraphQL mutation.

- [ ] **Step 1: Add the GraphQL mutation**

In `crm-proj/typedefs/taskTypeDefs.js`, add to `type Mutation { ... }`:

```graphql
    removeTaskAttachment(taskId: ID!): Task!
```

- [ ] **Step 2: Add the resolver**

In `crm-proj/resolvers/taskResolvers.js`, add to the `Mutation` object:

```js
        removeTaskAttachment: async (_, { taskId }, context) => {
            const groupId = requireCallerGroupId(context);
            const callerIdentity = context?.user ? `admin:${context.user.id}` : `member:${context.member.uuid}`;
            const isAdmin = !!context?.user;

            const { task: existing } = await getTaskForGroup(taskId, groupId);
            const attachment = existing.attachment;

            if (!attachment) {
                return mapTask(existing);
            }

            if (!isAdmin && attachment.uploadedBy !== callerIdentity) {
                throw new GraphQLError('Only the uploader or an admin can remove this attachment.', {
                    extensions: { code: 'FORBIDDEN' },
                });
            }

            const updated = await setTaskAttachment(taskId, groupId, null);
            await adjustBytesUsed(groupId, -attachment.sizeBytes);
            await deleteR2Object(attachment.key);

            return mapTask(updated);
        },
```

Confirm `GraphQLError` is already imported at the top of `resolvers/taskResolvers.js` — if not, add `import { GraphQLError } from 'graphql';`.

- [ ] **Step 3: Verify it compiles and existing tests still pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add typedefs/taskTypeDefs.js resolvers/taskResolvers.js
git commit -m "feat: add removeTaskAttachment mutation"
```

---

## Task 7: `taskAttachmentUrl` query

**Files:**
- Modify: `crm-proj/typedefs/taskTypeDefs.js`
- Modify: `crm-proj/resolvers/taskResolvers.js`

**Interfaces:**
- Consumes: `getTaskForGroup` (Task 5), `createDownloadUrl` (Task 3).
- Produces: `taskAttachmentUrl(taskId: ID!): String` GraphQL query — returns a fresh signed GET URL, or `null` if the task has no attachment.

- [ ] **Step 1: Add the GraphQL query**

In `crm-proj/typedefs/taskTypeDefs.js`, add to the existing `type Query { ... }` block:

```graphql
    taskAttachmentUrl(taskId: ID!): String
```

- [ ] **Step 2: Add the resolver**

In `crm-proj/resolvers/taskResolvers.js`, add to the imports:

```js
import { createDownloadUrl } from '../config/r2.js';
```

Add to the `Query` object:

```js
        taskAttachmentUrl: async (_, { taskId }, context) => {
            const groupId = requireCallerGroupId(context);
            const { task } = await getTaskForGroup(taskId, groupId);

            if (!task.attachment) {
                return null;
            }

            return createDownloadUrl(task.attachment.key);
        },
```

- [ ] **Step 3: Verify it compiles and existing tests still pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add typedefs/taskTypeDefs.js resolvers/taskResolvers.js
git commit -m "feat: add taskAttachmentUrl query"
```

---

## Task 8: Storage usage on `Billing`

**Files:**
- Modify: `crm-proj/typedefs/billingTypeDefs.js`
- Modify: `crm-proj/resolvers/billingResolvers.js`

**Interfaces:**
- Consumes: `getOrCreateStorageUsage` (Task 1).
- Produces: `Billing.storageBytesUsed: Float!` GraphQL field, read by the frontend's Billing page (Task 12). `Float`, not `Int` — a group's total usage can reach ~215GB on the Scale plan, which overflows GraphQL's 32-bit `Int` (max ~2.1GB); an individual file's `sizeBytes` stays `Int` since it's capped at 100MB.

- [ ] **Step 1: Extend the `Billing` type**

In `crm-proj/typedefs/billingTypeDefs.js`, add to the existing `type Billing { ... }` block:

```graphql
    storageBytesUsed: Float!
```

- [ ] **Step 2: Extend the `myBilling` resolver**

In `crm-proj/resolvers/billingResolvers.js`, add to the imports:

```js
import { getOrCreateStorageUsage } from '../models/storage.js';
```

Replace the existing `myBilling` resolver body:

```js
    myBilling: async (_, __, context) => {
      const groupId = requireCallerGroupId(context);
      return getOrCreateBilling(groupId);
    },
```

with:

```js
    myBilling: async (_, __, context) => {
      const groupId = requireCallerGroupId(context);
      const [billing, storageBytesUsed] = await Promise.all([
        getOrCreateBilling(groupId),
        getOrCreateStorageUsage(groupId),
      ]);
      return { ...billing, storageBytesUsed };
    },
```

- [ ] **Step 3: Verify it compiles and existing tests still pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add typedefs/billingTypeDefs.js resolvers/billingResolvers.js
git commit -m "feat: expose storageBytesUsed on Billing"
```

---

## Task 9: Frontend types + GraphQL queries

**Files:**
- Modify: `crm-frontend/src/types/index.ts`
- Modify: `crm-frontend/src/lib/queries.ts`

**Interfaces:**
- Produces: `TaskAttachment` interface, `Task.attachment: TaskAttachment | null`, `Billing.storageBytesUsed: number`, and the query/mutation strings `REQUEST_TASK_UPLOAD_URL`, `CONFIRM_TASK_ATTACHMENT`, `REMOVE_TASK_ATTACHMENT`, `TASK_ATTACHMENT_URL` — all consumed by Tasks 10 and 12.

- [ ] **Step 1: Add the `TaskAttachment` type**

In `crm-frontend/src/types/index.ts`, add near the `Task` interface:

```ts
export interface TaskAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}
```

Add to the `Task` interface (alongside the existing `submission: Submission | null;` line):

```ts
  attachment: TaskAttachment | null;
```

Add to the `Billing` interface (alongside `isLocked: boolean;`):

```ts
  storageBytesUsed: number;
```

- [ ] **Step 2: Select `attachment` in the task queries**

In `crm-frontend/src/lib/queries.ts`, add `attachment { filename contentType sizeBytes uploadedBy uploadedAt }` to both `GET_TASKS` and `GET_TASKS_FOR_MEMBER`'s selection sets — e.g.:

```ts
export const GET_TASKS = `
  query GetTasks {
    tasks {
      id clientId clientName taskName taskDescription serviceId
      assignedMembers dueDate createdBy priority statusId departmentId groupId createdAt recurringTaskId
      ${linkSelection} ${notesSelection} ${userSelection}
      submission { link note submittedBy submittedAt }
      revisions { id comment reviewedBy reviewedAt }
      attachment { filename contentType sizeBytes uploadedBy uploadedAt }
    }
  }
`;
```

(Apply the same single added line to `GET_TASKS_FOR_MEMBER`.)

- [ ] **Step 3: Add `storageBytesUsed` to `MY_BILLING`**

In `crm-frontend/src/lib/queries.ts`, add `storageBytesUsed` to the `MY_BILLING` query, alongside the existing `isLocked` line:

```ts
export const MY_BILLING = `
  query MyBilling {
    myBilling {
      groupId
      status
      plan
      trialEndsAt
      currentPeriodEnd
      isLocked
      storageBytesUsed
      limits { tier name priceMonthlyUsd adminLimit memberLimit storageGb aiNotesHoursPerMonth }
    }
  }
`;
```

- [ ] **Step 4: Add the new query/mutation strings**

In `crm-frontend/src/lib/queries.ts`, in the `--- Tasks ---` section (near `GET_TASKS`), add:

```ts
export const REQUEST_TASK_UPLOAD_URL = `
  mutation RequestTaskUploadUrl($taskId: ID!, $filename: String!, $contentType: String!, $sizeBytes: Int!) {
    requestTaskUploadUrl(taskId: $taskId, filename: $filename, contentType: $contentType, sizeBytes: $sizeBytes) {
      uploadUrl
      key
    }
  }
`;

export const CONFIRM_TASK_ATTACHMENT = `
  mutation ConfirmTaskAttachment($taskId: ID!, $key: String!, $filename: String!, $contentType: String!, $sizeBytes: Int!) {
    confirmTaskAttachment(taskId: $taskId, key: $key, filename: $filename, contentType: $contentType, sizeBytes: $sizeBytes) {
      id
      attachment { filename contentType sizeBytes uploadedBy uploadedAt }
    }
  }
`;

export const REMOVE_TASK_ATTACHMENT = `
  mutation RemoveTaskAttachment($taskId: ID!) {
    removeTaskAttachment(taskId: $taskId) {
      id
      attachment { filename contentType sizeBytes uploadedBy uploadedAt }
    }
  }
`;

export const TASK_ATTACHMENT_URL = `
  query TaskAttachmentUrl($taskId: ID!) {
    taskAttachmentUrl(taskId: $taskId)
  }
`;
```

- [ ] **Step 5: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/lib/queries.ts
git commit -m "feat: add frontend types and queries for task attachments"
```

---

## Task 10: `TaskAttachmentField` component

**Files:**
- Create: `crm-frontend/src/components/tasks/TaskAttachmentField.tsx`

**Interfaces:**
- Consumes: `TaskAttachment` type, `REQUEST_TASK_UPLOAD_URL`/`CONFIRM_TASK_ATTACHMENT`/`REMOVE_TASK_ATTACHMENT`/`TASK_ATTACHMENT_URL` (Task 9), `graphqlRequest` (existing, `src/lib/graphql.ts`), `Button`/`Banner` (existing UI components).
- Produces: `<TaskAttachmentField task={task} currentUserIdentity={identity} onChanged={() => void} />`, consumed by Task 11. `currentUserIdentity` is the caller's own `"admin:<id>"`/`"member:<uuid>"` string (used only to decide whether to show the Remove button for a non-admin — the backend is the actual authority).

- [ ] **Step 1: Write the component**

`crm-frontend/src/components/tasks/TaskAttachmentField.tsx`:

```tsx
import { useRef, useState } from 'react';
import type { Task } from '../../types';
import { graphqlRequest } from '../../lib/graphql';
import {
  REQUEST_TASK_UPLOAD_URL,
  CONFIRM_TASK_ATTACHMENT,
  REMOVE_TASK_ATTACHMENT,
  TASK_ATTACHMENT_URL,
} from '../../lib/queries';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Banner';

const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Attaches a file to a task, stored in R2. Deliberately its own component and its
// own set of mutations, separate from TaskLinkFields — same reasoning as that
// component: each save should only ever touch the field it shows.
export function TaskAttachmentField({
  task,
  currentUserIdentity,
  isAdmin,
  onChanged,
}: {
  task: Task;
  currentUserIdentity: string;
  isAdmin: boolean;
  onChanged?: (attachment: Task['attachment']) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attachment = task.attachment;
  const canRemove = isAdmin || attachment?.uploadedBy === currentUserIdentity;

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError('That file is larger than the 100MB limit.');
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const { requestTaskUploadUrl } = await graphqlRequest<{
        requestTaskUploadUrl: { uploadUrl: string; key: string };
      }>(REQUEST_TASK_UPLOAD_URL, {
        taskId: task.id,
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });

      const putResponse = await fetch(requestTaskUploadUrl.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResponse.ok) {
        throw new Error('Upload to storage failed. Try again.');
      }

      const { confirmTaskAttachment } = await graphqlRequest<{
        confirmTaskAttachment: Task;
      }>(CONFIRM_TASK_ATTACHMENT, {
        taskId: task.id,
        key: requestTaskUploadUrl.key,
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });

      onChanged?.(confirmTaskAttachment.attachment);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not attach the file.');
    } finally {
      setBusy(false);
    }
  }

  async function handleView() {
    setError(null);
    try {
      const { taskAttachmentUrl } = await graphqlRequest<{ taskAttachmentUrl: string | null }>(
        TASK_ATTACHMENT_URL,
        { taskId: task.id },
      );
      if (taskAttachmentUrl) {
        window.open(taskAttachmentUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the file.');
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy(true);
    try {
      const { removeTaskAttachment } = await graphqlRequest<{ removeTaskAttachment: Task }>(
        REMOVE_TASK_ATTACHMENT,
        { taskId: task.id },
      );
      onChanged?.(removeTaskAttachment.attachment);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-ink/[0.08] px-3.5 py-3 dark:border-white/10">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink/40 dark:text-white/40">
        Attachment
      </p>
      {attachment ? (
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={handleView}
            className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium text-accent-600 hover:underline dark:text-accent-400"
          >
            {attachment.filename}
          </button>
          <span className="shrink-0 text-[12px] text-ink/40 dark:text-white/40">
            {formatSize(attachment.sizeBytes)}
          </span>
          {canRemove && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={busy}
              className="shrink-0 text-[12.5px] font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="mt-1">
          <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} loading={busy}>
            Attach a file
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileSelected}
        className="hidden"
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
git add src/components/tasks/TaskAttachmentField.tsx
git commit -m "feat: add TaskAttachmentField component"
```

---

## Task 11: Wire `TaskAttachmentField` into the task modals

**Files:**
- Modify: `crm-frontend/src/components/tasks/TaskDetailModal.tsx`
- Modify: `crm-frontend/src/components/member/MemberTaskModal.tsx`

**Interfaces:**
- Consumes: `TaskAttachmentField` (Task 10). Needs the current caller's identity string and admin/member status — both modals already have access to the signed-in user or member via existing auth context hooks (`useAuth()` for admin views, member session context for the member portal).

`TaskFormModal.tsx` is **not** included here — it does not render `TaskLinkFields` either (it's the create-task form; attachments only make sense once a task exists). Only the two places `TaskLinkFields` already renders get `TaskAttachmentField` alongside it.

- [ ] **Step 1: Wire it into `TaskDetailModal.tsx`**

Find the existing line:

```tsx
        <TaskLinkFields task={task} onChanged={onChanged} onLiveLinkChange={setLocalLiveLink} />
```

In `crm-frontend/src/components/tasks/TaskDetailModal.tsx`. Check the top of this file for how the signed-in admin is obtained (likely `const { user } = useAuth();` already in scope, since this is an admin-only modal). Add directly below the `TaskLinkFields` line:

```tsx
        {user && (
          <div className="mt-3">
            <TaskAttachmentField
              task={task}
              currentUserIdentity={`admin:${user.id}`}
              isAdmin
              onChanged={() => onChanged?.()}
            />
          </div>
        )}
```

Add the import at the top of the file:

```tsx
import { TaskAttachmentField } from './TaskAttachmentField';
```

(If `user` from `useAuth()` is not already destructured in this file, add it: `const { user } = useAuth();`, importing `useAuth` from `'../../context/AuthContext'` if not already imported.)

- [ ] **Step 2: Wire it into `MemberTaskModal.tsx`**

Find the existing line:

```tsx
        <TaskLinkFields task={task} onChanged={onChanged} onLiveLinkChange={setLocalLiveLink} />
```

In `crm-frontend/src/components/member/MemberTaskModal.tsx`. Check the top of this file for how the signed-in member is obtained (likely a member session context hook already in scope, since this is the member-portal modal). Add directly below the `TaskLinkFields` line:

```tsx
        {member && (
          <div className="mt-3">
            <TaskAttachmentField
              task={task}
              currentUserIdentity={`member:${member.uuid}`}
              isAdmin={false}
              onChanged={() => onChanged?.()}
            />
          </div>
        )}
```

Add the import at the top of the file:

```tsx
import { TaskAttachmentField } from '../tasks/TaskAttachmentField';
```

(Match whatever the existing member-identity variable is actually called in this file — it may not be named `member`; use the same one `TaskLinkFields`'s surrounding code already reads from.)

- [ ] **Step 3: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 4: Commit**

```bash
git add src/components/tasks/TaskDetailModal.tsx src/components/member/MemberTaskModal.tsx
git commit -m "feat: wire TaskAttachmentField into task detail modals"
```

---

## Task 12: Storage usage on the Billing page

**Files:**
- Modify: `crm-frontend/src/pages/Billing.tsx`

**Interfaces:**
- Consumes: `billing.storageBytesUsed` and `billing.limits.storageGb` (Task 9's type extension; already fetched by the existing `useBilling()` call in this file).

- [ ] **Step 1: Add the storage-usage line**

In `crm-frontend/src/pages/Billing.tsx`, find the admin-usage block added previously (the one reading `groupUsers.length` of `billing.limits.adminLimit`). Add directly below it, still inside the same `{billing?.plan && (...)}` conditional block:

```tsx
            <p className="mt-1 text-sm text-ink/70 dark:text-white/70">
              {(billing.storageBytesUsed / 1024 ** 3).toFixed(2)} GB of {billing.limits.storageGb} GB storage used
            </p>
```

- [ ] **Step 2: Verify the frontend still type-checks**

Run: `npx tsc -b`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
git add src/pages/Billing.tsx
git commit -m "feat: show storage usage on the Billing page"
```

---

## Final Verification

- [ ] Backend: `cd crm-proj && npm test` — all tests pass (existing suite + new `utils/attachments.test.js`).
- [ ] Frontend: `cd crm-frontend && npx tsc -b` — clean.
- [ ] Manual verification (per the spec's Testing section): upload an allowed file under quota, upload an over-quota/disallowed-type file (rejected before any bytes send), replace an existing attachment (old file's bytes freed — check `group_storage.bytes_used`), remove as uploader, remove as a different admin, attempt remove as a different member (rejected), view an attachment, confirm the Billing page's storage line updates after each.
