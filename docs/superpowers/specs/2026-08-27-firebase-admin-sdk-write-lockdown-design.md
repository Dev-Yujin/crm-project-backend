# Firebase Admin SDK Migration & Write Lockdown — Design

## Problem

The Firebase Realtime Database backing this app currently has fully open security rules — `.read: true, .write: true` at the root, with no authentication check at all. Anyone with the database URL (which is public — it's embedded in the frontend's JS bundle) can read or write any data: client records, tasks, member records, everything.

Investigation found the reason this can't simply be "fixed with rules": **neither the frontend nor the backend authenticate to Firebase at all.** Both connect via the plain `firebase` client SDK as fully anonymous clients. Firebase security rules can only condition on an `auth` object populated by a real Firebase Auth session — and since there is no bridge from this app's actual identity systems (Supabase sessions for admin/user accounts, a custom member bearer-token system for CRM staff) into Firebase Auth, `auth` is always `null` for every connection, including the backend's own writes.

This means tightening rules today would break the backend's own writes along with blocking everyone else — the backend needs a way to be trusted first.

## Scope

Read access scoping (making sure only the right group can *read* their own data) requires restructuring every top-level collection from flat-with-a-`groupId`-field to nested-by-group paths, since Firebase RTDB rules cannot filter `orderByChild().equalTo()` query results — a rule only allows or denies an entire location. That's a separate, larger migration (see Follow-up below) and explicitly **out of scope** for this plan.

This plan covers only: **locking down writes.** That's the more dangerous half of the current exposure (anyone can corrupt or delete data, not just view it), and it's achievable without touching the data model at all.

## Architecture

The backend migrates from the plain `firebase` client SDK to `firebase-admin` — a trusted service-account credential that bypasses RTDB security rules entirely, by design (that's the standard, correct way for a trusted server to talk to Firebase). Once the backend authenticates this way, RTDB rules flip from `.write: true` to `.write: false`: nobody but the backend's Admin SDK connection can write, regardless of rule evaluation, since Admin SDK writes never go through rules at all.

The frontend is untouched. It never writes to Firebase directly today — all writes go through the backend's GraphQL API, and the frontend's own Firebase usage (`src/lib/realtime.ts`) is read-only subscriptions. Reads stay open (`.read: true`) for now; that's the follow-up plan's problem, not this one's.

**Staged rollout, to avoid any risk of locking out writes:**
1. Ship the Admin SDK migration with rules left exactly as they are today (`.write: true`). Confirm in production that the backend still writes correctly through its new Admin SDK connection.
2. Only once that's confirmed working, flip `.write: false` in the Firebase Console. If anything were wrong with the Admin SDK wiring, step 1 catches it before anything is locked down — the rules change is a separate, quick, easily-reversible step at the end.

## Components

1. **Service account key** — already generated and in place at `crm-proj/config/crm-backend-df5ea-firebase-adminsdk-fbsvc-3393371583.json`, now gitignored (`*firebase-adminsdk*.json` added to `.gitignore`). This file must never be committed; it's the credential that grants full admin access to the Firebase project.

2. **Secret delivery via environment variable, not a checked-in file path.** Even though the file is gitignored, hardcoding a local file path in source code is fragile across environments (dev machine vs. production host) and risks the file itself being copied somewhere less careful. Instead:
   - Add `GOOGLE_APPLICATION_CREDENTIALS_JSON` (or similar) to `.env`, holding the *entire contents* of the service account JSON as a single-line string.
   - `config/firebase.js` reads that env var, `JSON.parse`s it, and passes the result to `admin.credential.cert(...)`.
   - In production, whatever hosting platform is in use gets the same env var set through its own secret/env config — the JSON file itself never needs to leave the local machine or be uploaded anywhere.

3. **`crm-proj/config/firebase.js`** — rewritten to initialize `firebase-admin` instead of the client SDK:
   ```js
   import admin from "firebase-admin";
   const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
   export const app = admin.initializeApp({
     credential: admin.credential.cert(serviceAccount),
     databaseURL: process.env.FIREBASE_DATABASE_URL,
   });
   ```
   Fails loudly (throws) at startup if the env var is missing or fails to parse — not a silent fallback to an unauthenticated connection.

4. **Seven model files + the migration script**, each currently `import { getDatabase, ref, get, set, update, push, remove, serverTimestamp } from "firebase/database"`:
   - `models/task.js`
   - `models/recurringTasks.js`
   - `models/services.js`
   - `models/taskStatuses.js`
   - `models/departments.js`
   - `models/clients.js`
   - `scripts/backfill-submission-to-livelink.js`

   These switch to the Admin SDK's equivalent API: `admin.database()` in place of `getDatabase(app)`, with `ref()`, `get()`, `set()`, `update()`, `push()`, `remove()` all present with near-identical signatures. `serverTimestamp()` (client SDK) becomes `admin.database.ServerValue.TIMESTAMP` (Admin SDK) — the one call-shape difference worth calling out explicitly, since it's easy to miss.

5. **RTDB rules** — no rules file exists in the repo today (rules currently live only in the Firebase Console). As part of this work, add a `database.rules.json` to the repo so rules are version-controlled going forward, containing:
   ```json
   {
     "rules": {
       ".read": true,
       ".write": false,
       "taskStatuses": { ".indexOn": ["groupId"] },
       "tasks": { ".indexOn": ["groupId"] },
       "clients": { ".indexOn": ["groupId"] },
       "services": { ".indexOn": ["groupId"] },
       "departments": { ".indexOn": ["groupId"] }
     }
   }
   ```
   This file is documentation/version-control only in this plan — actually deploying it requires either the Firebase CLI (not currently set up in this repo — out of scope to add `firebase.json` + CLI tooling here) or pasting it into the Firebase Console manually, which is what actually applies it. The plan's rollout section covers pasting this into the Console as the final step, after the Admin SDK migration is confirmed working.

## Error Handling

- Missing/malformed service account env var: the backend must fail to start, with a clear error naming the missing variable — not start up in a degraded state that silently can't write to Firebase.
- Any model file that fails to convert correctly (e.g. a missed `serverTimestamp()` call) would surface as a runtime error on that specific write path during manual verification — each collection's create/edit/delete needs to be individually exercised (see Testing).

## Testing

No automated test suite exists in this repo (pre-existing, not something this plan introduces). Verification is manual, in two stages matching the rollout:

**Stage 1 (Admin SDK live, rules still open):** for each of the 6 collections, exercise a full create → edit → delete cycle through the app or GraphQL directly, confirming data actually lands in and updates in Firebase (check via the Firebase Console's Data view). Run the migration script's dry run again to confirm it still connects and reads correctly under the new SDK.

**Stage 2 (after flipping `.write: false` in the Console):** repeat the same create/edit/delete cycle — confirm the backend *still* works (proving Admin SDK genuinely bypasses rules). Then attempt a raw unauthenticated write directly against the RTDB REST endpoint (e.g. `curl -X PUT ".../tasks/test.json" -d '{"fake":"data"}'`) and confirm it's now rejected — proving the lockdown actually took effect.

## Follow-up (explicitly out of scope here)

Read-side access scoping — restructuring every collection to `collection/{groupId}/{id}` nested paths, updating every read site in both the backend models and the frontend's `subscribeToCollection` helper, migrating existing flat data into the new shape, and writing real per-group `.read` rules keyed on a Firebase Auth token minted from the user's existing Supabase/member session. This is a separate plan, to be brainstormed on its own once this one has shipped and settled.
