# Admin & Member Profile Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin change their name and set/change/remove a profile picture, and let a member set/change/remove theirs — all pictures stored as resized/compressed base64 JPEGs.

**Architecture:** Two new nullable `text` columns (`groups.avatar_base64`, `members.avatar_base64`) hold the pictures — deliberately outside Supabase Auth metadata, which gets embedded in every JWT. A new admin mutation (`updateUserProfile`) and an extension to the existing `editMemberProfile` mutation write them. A shared, pure size-validation helper guards both. On the frontend, one reusable `AvatarUpload` component (client-side canvas resize to a 256×256 JPEG) is used from a new "My Profile" section on the admin Team page and from the existing member profile view.

**Tech Stack:** Node/Express/Apollo Server 5 + Postgres (crm-proj); React 19/TypeScript (crm-frontend). No new dependencies in either repo — resizing uses the browser's native `<canvas>`, not a library.

## Global Constraints

- Photos are resized/cropped to a 256×256 square and re-encoded as JPEG (quality 0.8) **client-side**, before ever being turned into base64 or sent anywhere.
- Backend rejects any `avatarBase64` value longer than 300,000 characters (defense in depth beyond the client-side resize).
- Avatars are stored in `groups.avatar_base64` (admin) / `members.avatar_base64` (member) — **not** in Supabase Auth `user_metadata`, to avoid bloating every JWT this app issues.
- Both `updateUserProfile` and `editMemberProfile` use "omit a field to leave it unchanged; pass `avatarBase64: null` explicitly to remove the photo" semantics.
- Member roster/mention avatars elsewhere in the app are explicitly out of scope — only the admin's own sidebar identity, the new admin "My Profile" section, and the existing member profile view.
- Spec: `docs/superpowers/specs/2026-08-30-profile-avatar-design.md`.

---

## Task 1: `avatar_base64` columns

**Files:**
- Create: `crm-proj/scripts/add-avatar-columns.js`

**Interfaces:**
- Produces: `groups.avatar_base64` and `members.avatar_base64` columns (nullable `text`), which every later backend task reads/writes via `pool.query`.

This runs DDL against the shared Supabase database that already backs the live app — **confirm with the user before running Step 2**, even though the change is purely additive (`IF NOT EXISTS` guards, no existing column touched or altered).

- [ ] **Step 1: Write the migration script**

`crm-proj/scripts/add-avatar-columns.js`:

```js
// One-time setup: adds the avatar_base64 columns backing the admin/member profile-picture
// feature (see docs/superpowers/specs/2026-08-30-profile-avatar-design.md). Idempotent —
// IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/add-avatar-columns.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Adding groups.avatar_base64 (if missing)...");
  await pool.query('ALTER TABLE groups ADD COLUMN IF NOT EXISTS avatar_base64 text');

  console.log("Adding members.avatar_base64 (if missing)...");
  await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS avatar_base64 text');

  const check = await pool.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'avatar_base64'
    ORDER BY table_name
  `);
  console.log(
    "avatar_base64 now present on:",
    check.rows.map((r) => r.table_name).join(', ') || '(none — something went wrong)',
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it (after confirming with the user)**

Run: `cd crm-proj && node scripts/add-avatar-columns.js`
Expected: prints `avatar_base64 now present on: groups, members`.

- [ ] **Step 3: Verify idempotency**

Run the same command again.
Expected: same output, no error.

- [ ] **Step 4: Commit**

```bash
git add scripts/add-avatar-columns.js
git commit -m "Add avatar_base64 columns to groups and members"
```

---

## Task 2: Avatar size validation

**Files:**
- Create: `crm-proj/utils/avatar.js`
- Test: `crm-proj/utils/avatar.test.js`

**Interfaces:**
- Produces: `validateAvatarBase64(value: unknown): void` — throws a plain `Error` with a message if `value` is a non-null, non-string, or an over-length string; returns (no throw) for `null`/`undefined`/a reasonably-sized string. Consumed by Task 3 (`resolvers/userResolvers.js`) and Task 4 (`resolvers/memberResolvers.js`).

- [ ] **Step 1: Write the failing tests**

`crm-proj/utils/avatar.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { validateAvatarBase64 } from './avatar.js';

describe('validateAvatarBase64', () => {
  it('accepts a normal-sized data URL', () => {
    expect(() => validateAvatarBase64('data:image/jpeg;base64,' + 'a'.repeat(1000))).not.toThrow();
  });

  it('accepts null (explicit "remove the photo")', () => {
    expect(() => validateAvatarBase64(null)).not.toThrow();
  });

  it('accepts undefined ("field not provided")', () => {
    expect(() => validateAvatarBase64(undefined)).not.toThrow();
  });

  it('rejects a string over the size cap', () => {
    expect(() => validateAvatarBase64('a'.repeat(300_001))).toThrow(/too large/);
  });

  it('accepts a string exactly at the size cap', () => {
    expect(() => validateAvatarBase64('a'.repeat(300_000))).not.toThrow();
  });

  it('rejects a non-string value', () => {
    expect(() => validateAvatarBase64(12345)).toThrow(/must be a string/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm-proj && npm test`
Expected: FAIL — `utils/avatar.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

`crm-proj/utils/avatar.js`:

```js
// A properly resized 256x256 JPEG data URL typically comes out to 50-150KB of base64 —
// 300,000 characters is generous headroom over that, enough to catch a client that
// skipped the resize step (a modified client, a bug) without rejecting real photos.
const MAX_AVATAR_BASE64_LENGTH = 300_000;

// Throws if a client-supplied avatar value is unreasonably large or the wrong type.
// null/undefined both pass through untouched — both are valid "no avatar" / "don't
// touch it" signals to the callers of this function, not error cases.
export function validateAvatarBase64(value) {
  if (value == null) return;
  if (typeof value !== 'string') {
    throw new Error('avatarBase64 must be a string or null');
  }
  if (value.length > MAX_AVATAR_BASE64_LENGTH) {
    throw new Error(
      `avatarBase64 is too large (${value.length} characters, max ${MAX_AVATAR_BASE64_LENGTH})`,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm-proj && npm test`
Expected: PASS (6 new tests; 34 total across the whole suite, up from 28).

- [ ] **Step 5: Commit**

```bash
git add utils/avatar.js utils/avatar.test.js
git commit -m "Add avatar size validation with tests"
```

---

## Task 3: Admin name + avatar mutation

**Files:**
- Modify: `crm-proj/typedefs/userTypeDefs.js`
- Modify: `crm-proj/resolvers/userResolvers.js`
- Modify: `crm-proj/models/groups.js`

**Interfaces:**
- Consumes: `validateAvatarBase64` (Task 2); `pool` from `crm-proj/config/supabase.js` (existing); `createRequestSupabaseClient` from `crm-proj/utils/supabaseServerClient.js` (existing, already used elsewhere in this file); `requireUser` from `crm-proj/utils/requireUser.js` (existing).
- Produces: `updateUserAvatar(userId: string, avatarBase64: string | null): Promise<void>` and `getUserAvatar(userId: string): Promise<string | null>` in `models/groups.js`. The GraphQL `updateUserProfile` mutation and the `avatarBase64` field on `User`, both consumed by the frontend (Task 5+).

- [ ] **Step 1: Add the model functions**

In `crm-proj/models/groups.js`, add at the end of the file (after the existing `getMyGroup` export):

```js

//Sets or clears the caller's own profile-picture data URL. null clears it.
export const updateUserAvatar = async (userId, avatarBase64) => {
    await pool.query('UPDATE groups SET avatar_base64 = $1 WHERE "userId" = $2', [avatarBase64, userId]);
};

//Reads the caller's own profile-picture data URL, if any.
export const getUserAvatar = async (userId) => {
    const result = await pool.query('SELECT avatar_base64 FROM groups WHERE "userId" = $1 LIMIT 1', [userId]);
    return result.rows[0]?.avatar_base64 ?? null;
};
```

- [ ] **Step 2: Update the typedefs**

Replace the entire contents of `crm-proj/typedefs/userTypeDefs.js` with:

```js
const userTypeDefs = `#graphql
  type Query {
    "Cookie-based — resolves the caller's own Supabase session. accessToken arg is a fallback for non-browser callers (scripts, tests); the browser app never needs to pass it."
    currentUser(accessToken: String): User
  }

  type Mutation {
    registerUser(name: String!, email: String!, password: String!): AuthPayload!
    loginUser(email: String!, password: String!): AuthPayload!
    signOutUser: Boolean!
    "Updates the caller's own name and/or avatar. Omit a field to leave it unchanged; pass avatarBase64: null explicitly to remove the photo."
    updateUserProfile(name: String, avatarBase64: String): User!
  }

  type User {
    id: ID!
    email: String
    name: String
    avatarBase64: String
  }

  "No session field — the session is set as an httpOnly cookie on the response instead. See ADMIN_SESSION_SECURITY_INTEGRATION.md. Google sign-in is a plain redirect to GET /auth/google on the API host, not a mutation."
  type AuthPayload {
    user: User
  }
`;

export default userTypeDefs;
```

- [ ] **Step 3: Update the resolvers**

Replace the entire contents of `crm-proj/resolvers/userResolvers.js` with:

```js
import { GraphQLError } from 'graphql';
import { fetchCurrentUser } from '../models/userFunctions.js';
import { createRequestSupabaseClient } from '../utils/supabaseServerClient.js';
import { requireUser } from '../utils/requireUser.js';
import { getUserAvatar, updateUserAvatar } from '../models/groups.js';
import { validateAvatarBase64 } from '../utils/avatar.js';

const mapUser = (user, avatarBase64 = null) => user && {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name ?? null,
    avatarBase64,
};

const userResolvers = {
    Query: {
        // Prefers the Supabase session cookie (already resolved into context.user by
        // server.js); accessToken arg is a fallback for non-browser callers only.
        currentUser: async (_, { accessToken }, context) => {
            if (context?.user) {
                const avatarBase64 = await getUserAvatar(context.user.id);
                return mapUser(context.user, avatarBase64);
            }
            if (!accessToken) {
                return null;
            }
            const user = await fetchCurrentUser(accessToken);
            const avatarBase64 = await getUserAvatar(user.id);
            return mapUser(user, avatarBase64);
        },
    },
    Mutation: {
        // Uses a request-scoped Supabase client (see utils/supabaseServerClient.js) so the
        // resulting session is set as an httpOnly cookie on this response — never returned
        // in the body, never touched by browser JS.
        registerUser: async (_, { name, email, password }, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: { data: { name } },
            });

            if (error) {
                throw error;
            }

            // A freshly registered user cannot have an avatar yet — no need to query.
            return { user: mapUser(data.user, null) };
        },
        loginUser: async (_, { email, password }, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });

            if (error) {
                throw error;
            }

            const avatarBase64 = await getUserAvatar(data.user.id);
            return { user: mapUser(data.user, avatarBase64) };
        },
        signOutUser: async (_, __, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { error } = await supabase.auth.signOut();

            if (error) {
                throw error;
            }

            return true;
        },
        // Updates whichever of name/avatarBase64 was provided. avatarBase64: null clears
        // the photo; omitting it entirely leaves the stored value untouched.
        updateUserProfile: async (_, { name, avatarBase64 }, context) => {
            const user = requireUser(context);

            if (avatarBase64 !== undefined) {
                try {
                    validateAvatarBase64(avatarBase64);
                } catch (err) {
                    throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
                }
                await updateUserAvatar(user.id, avatarBase64);
            }

            if (name !== undefined) {
                const supabase = createRequestSupabaseClient(context.req, context.res);
                const { error } = await supabase.auth.updateUser({ data: { name } });
                if (error) {
                    throw error;
                }
            }

            const freshAvatarBase64 = await getUserAvatar(user.id);
            return mapUser(
                { ...user, user_metadata: { ...user.user_metadata, ...(name !== undefined ? { name } : {}) } },
                freshAvatarBase64,
            );
        },
    },
};

export default userResolvers;
```

- [ ] **Step 4: Sanity-check the modules load**

Run: `cd crm-proj && node -e "Promise.all([import('./typedefs/userTypeDefs.js'), import('./resolvers/userResolvers.js'), import('./models/groups.js')]).then(() => console.log('modules load OK'))"`
Expected: `modules load OK`

- [ ] **Step 5: Commit**

```bash
git add typedefs/userTypeDefs.js resolvers/userResolvers.js models/groups.js
git commit -m "Add updateUserProfile mutation (admin name + avatar)"
```

---

## Task 4: Member avatar extension

**Files:**
- Modify: `crm-proj/typedefs/memberTypeDefs.js`
- Modify: `crm-proj/resolvers/memberResolvers.js`
- Modify: `crm-proj/models/membersFunction.js`

**Interfaces:**
- Consumes: `validateAvatarBase64` (Task 2).
- Produces: `avatarBase64` field on `Member`, and the same optional argument on the existing `editMemberProfile` mutation.

- [ ] **Step 1: Update the typedefs**

In `crm-proj/typedefs/memberTypeDefs.js`, add `avatarBase64: String` to the `Member` type (after `inviteError: String`):

```graphql
  type Member {
    uuid: ID!
    username: String!
    email: String!
    groupId: ID
    createdAt: String
    inviteSent: Boolean
    inviteError: String
    avatarBase64: String
  }
```

And extend `editMemberProfile`'s signature (in the `Mutation` type):

```graphql
    "For a user (admin): uuid is required, edits a member in the caller's own group. For a member: uuid is ignored, always edits the caller's own profile. avatarBase64: null explicitly removes the photo; omit it to leave the photo untouched."
    editMemberProfile(uuid: ID, username: String, email: String, password: String, avatarBase64: String): Member!
```

- [ ] **Step 2: Update `models/membersFunction.js`**

In `crm-proj/models/membersFunction.js`, update `loginMember`'s `SELECT` (the `query` const inside `loginMember`) to include the new column:

```js
        const query = 'SELECT uuid, username, email, password, group_id, token_version, avatar_base64 FROM members WHERE email = $1';
```

Update `fetchMemberFromToken`'s `SELECT` similarly:

```js
        const query = 'SELECT uuid, username, email, group_id, created_at, token_version, avatar_base64 FROM members WHERE uuid = $1';
```

Replace the entire `editMemberProfile` function with:

```js
//Edit a member's profile. Called by both actor types:
//  - a member editing their OWN profile: uuid must come from their verified token (resolver
//    passes caller.uuid, never client input), groupId omitted (self-edit needs no extra check)
//  - a user (admin) editing a member they manage: groupId is required and enforced here, so
//    an admin can't reach into another group's member by guessing a uuid
export const editMemberProfile = async (uuid, { username, email, password, avatarBase64 } = {}, groupId = null) => {
    try {
        const fields = [];
        const values = [];
        let i = 1;

        if (username !== undefined) {
            fields.push(`username = $${i++}`);
            values.push(username);
        }
        if (email !== undefined) {
            fields.push(`email = $${i++}`);
            values.push(email);
        }
        if (password !== undefined) {
            fields.push(`password = $${i++}`);
            values.push(await hashPassword(password));
            //Changing the password invalidates every other outstanding token for this member —
            //including one forced by an admin resetting it on their behalf.
            fields.push(`token_version = token_version + 1`);
        }
        if (avatarBase64 !== undefined) {
            fields.push(`avatar_base64 = $${i++}`);
            values.push(avatarBase64);
        }

        if (fields.length === 0) {
            throw new Error('No fields provided to update');
        }

        values.push(uuid);
        let query = `UPDATE members SET ${fields.join(', ')} WHERE uuid = $${i}`;

        if (groupId != null) {
            values.push(groupId);
            query += ` AND group_id = $${i + 1}`;
        }

        query += ' RETURNING uuid, username, email, group_id, created_at, avatar_base64';
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        return result.rows[0];
    } catch (error) {
        console.error('Error editing member profile:', error);
        throw error;
    }
};
```

(`getAllMembers` — used only for the admin roster listing — is deliberately left unchanged: roster/mention avatars are out of scope for this spec, so there's no reason to select the column there.)

- [ ] **Step 3: Update `resolvers/memberResolvers.js`**

Add `avatarBase64` to `mapMember` (near the top of the file):

```js
const mapMember = (row) => row && {
    uuid: row.uuid,
    username: row.username,
    email: row.email,
    groupId: row.group_id ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
    avatarBase64: row.avatar_base64 ?? null,
};
```

Replace the `editMemberProfile` mutation resolver with:

```js
        // Called by both actor types: a user (admin) editing a member they manage — uuid arg
        // is required and scoped to the caller's own group — or a member editing their OWN
        // profile, where the uuid arg is ignored and identity comes from their token instead.
        editMemberProfile: async (_, { uuid, username, email, password, avatarBase64 }, context) => {
            if (avatarBase64 !== undefined) {
                try {
                    validateAvatarBase64(avatarBase64);
                } catch (err) {
                    throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
                }
            }
            if (context?.user) {
                const groupId = requireGroup(context);
                const member = await editMemberProfile(uuid, { username, email, password, avatarBase64 }, groupId);
                return mapMember(member);
            }
            const caller = requireMember(context);
            const member = await editMemberProfile(caller.uuid, { username, email, password, avatarBase64 });
            return mapMember(member);
        },
```

And add the import at the top of the file, alongside the existing imports:

```js
import { validateAvatarBase64 } from '../utils/avatar.js';
```

- [ ] **Step 4: Sanity-check the modules load**

Run: `cd crm-proj && node -e "Promise.all([import('./typedefs/memberTypeDefs.js'), import('./resolvers/memberResolvers.js'), import('./models/membersFunction.js')]).then(() => console.log('modules load OK'))"`
Expected: `modules load OK`

- [ ] **Step 5: Run the full suite**

Run: `cd crm-proj && npm test`
Expected: PASS (34 tests total — unchanged from Task 2, since this task adds no new automated tests, matching the established convention that DB-touching resolver code is verified manually/end-to-end rather than unit tested).

- [ ] **Step 6: Commit**

```bash
git add typedefs/memberTypeDefs.js resolvers/memberResolvers.js models/membersFunction.js
git commit -m "Add avatarBase64 to editMemberProfile"
```

---

## Task 5: Frontend types + GraphQL queries

**Files:**
- Modify: `crm-frontend/src/types/index.ts`
- Modify: `crm-frontend/src/lib/queries.ts`

**Interfaces:**
- Produces: `AppUser.avatarBase64`, `Member.avatarBase64`; updated `CURRENT_USER`, `REGISTER_USER`, `LOGIN_USER`, `EDIT_MEMBER_PROFILE` query strings; new `UPDATE_USER_PROFILE` mutation string. Consumed by Tasks 6-10.

- [ ] **Step 1: Update the types**

In `crm-frontend/src/types/index.ts`, add `avatarBase64` to `AppUser` (lines 2-6):

```ts
export interface AppUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarBase64: string | null;
}
```

And to `Member` (in the block starting `export interface Member {`, after `inviteError?: string | null;`):

```ts
  avatarBase64?: string | null;
```

- [ ] **Step 2: Update `CURRENT_USER`, `REGISTER_USER`, `LOGIN_USER`**

In `crm-frontend/src/lib/queries.ts`, update all three field selections to include `avatarBase64`:

```ts
export const REGISTER_USER = `
  mutation RegisterUser($name: String!, $email: String!, $password: String!) {
    registerUser(name: $name, email: $email, password: $password) {
      user { id email name avatarBase64 }
    }
  }
`;

export const LOGIN_USER = `
  mutation LoginUser($email: String!, $password: String!) {
    loginUser(email: $email, password: $password) {
      user { id email name avatarBase64 }
    }
  }
`;
```

```ts
export const CURRENT_USER = `
  query CurrentUser {
    currentUser { id email name avatarBase64 }
  }
`;
```

- [ ] **Step 3: Add `UPDATE_USER_PROFILE`**

Add after `CURRENT_USER`:

```ts
export const UPDATE_USER_PROFILE = `
  mutation UpdateUserProfile($name: String, $avatarBase64: String) {
    updateUserProfile(name: $name, avatarBase64: $avatarBase64) { id email name avatarBase64 }
  }
`;
```

- [ ] **Step 4: Update `EDIT_MEMBER_PROFILE`**

Replace:

```ts
export const EDIT_MEMBER_PROFILE = `
  mutation EditMemberProfile($uuid: ID!, $username: String, $email: String, $password: String, $avatarBase64: String) {
    editMemberProfile(uuid: $uuid, username: $username, email: $email, password: $password, avatarBase64: $avatarBase64) {
      uuid username email groupId createdAt avatarBase64
    }
  }
`;
```

- [ ] **Step 5: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors. Neither `AppUser` nor `Member` is ever constructed as an object literal in this codebase — both types only ever arrive already-shaped from `graphqlRequest<...>()` responses, which TypeScript doesn't structurally validate against the network response — so adding a field to the interface doesn't break any existing call site. Tasks 6-10 are what actually *use* the new field.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/lib/queries.ts
git commit -m "Add avatarBase64 to user/member types and queries"
```

---

## Task 6: `AuthContext` refetch

**Files:**
- Modify: `crm-frontend/src/context/AuthContext.tsx`

**Interfaces:**
- Consumes: `CURRENT_USER` (Task 5).
- Produces: `refetchUser(): Promise<void>` added to `AuthContextValue`, consumed by Task 8 (Team.tsx, after saving a profile change) — re-runs the same query the initial load uses and updates `user` state, matching the `refetch` pattern already used by `GroupContext`/`BillingContext` elsewhere in this app.

- [ ] **Step 1: Add the function**

In `crm-frontend/src/context/AuthContext.tsx`, add `refetchUser` to the `AuthContextValue` interface (after `signOut: () => Promise<void>;`):

```ts
  refetchUser: () => Promise<void>;
```

Add the implementation inside `AuthProvider`, after the `signOut` function:

```tsx
  async function refetchUser() {
    try {
      const { currentUser } = await graphqlRequest<{ currentUser: AppUser | null }>(CURRENT_USER);
      setUser(currentUser);
    } catch {
      // A transient failure here shouldn't clear a user that's already loaded and working.
    }
  }
```

Add it to the provider's `value`:

```tsx
    <AuthContext.Provider
      value={{ user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut, refetchUser }}
    >
```

- [ ] **Step 2: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/context/AuthContext.tsx
git commit -m "Add refetchUser to AuthContext"
```

---

## Task 7: `AvatarUpload` component

**Files:**
- Create: `crm-frontend/src/components/ui/AvatarUpload.tsx`

**Interfaces:**
- Produces: `AvatarUpload({ avatarBase64, fallbackInitial, onChange }: { avatarBase64: string | null; fallbackInitial: string; onChange: (avatarBase64: string | null) => Promise<void> })`. Consumed by Tasks 8 and 9.

- [ ] **Step 1: Write the implementation**

`crm-frontend/src/components/ui/AvatarUpload.tsx`:

```tsx
import { useRef, useState, type ChangeEvent } from 'react';

const MAX_DIMENSION = 256;
const JPEG_QUALITY = 0.8;

// Crops the image to a centered square, then scales that square down to
// MAX_DIMENSION x MAX_DIMENSION and re-encodes as JPEG — entirely client-side, so
// nothing larger than a small thumbnail is ever turned into base64 or sent anywhere.
function resizeImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode the selected file as an image.'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;

        const canvas = document.createElement('canvas');
        canvas.width = MAX_DIMENSION;
        canvas.height = MAX_DIMENSION;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas is not supported in this browser.'));
          return;
        }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, MAX_DIMENSION, MAX_DIMENSION);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

interface AvatarUploadProps {
  avatarBase64: string | null;
  fallbackInitial: string;
  onChange: (avatarBase64: string | null) => Promise<void>;
}

// Click the circle (or "Add/Change photo") to pick a file — it's resized/cropped to a
// 256x256 JPEG entirely client-side before onChange ever sees it. "Remove" calls
// onChange(null) to clear it. onChange is expected to call the relevant GraphQL mutation
// and update whatever local state the caller keeps — this component holds no state of
// its own beyond the in-flight/error UI.
export function AvatarUpload({ avatarBase64, fallbackInitial, onChange }: AvatarUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError(null);
    setPending(true);
    try {
      const dataUrl = await resizeImageFile(file);
      await onChange(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the photo.');
    } finally {
      setPending(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setPending(true);
    try {
      await onChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the photo.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/10 text-[22px] font-semibold text-ink/60 transition hover:opacity-80 disabled:opacity-50 dark:bg-white/10 dark:text-white/70"
        aria-label="Change profile picture"
      >
        {avatarBase64 ? (
          <img src={avatarBase64} alt="Profile" className="h-full w-full object-cover" />
        ) : (
          fallbackInitial
        )}
      </button>
      <div className="flex flex-col gap-1">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={pending}
            className="text-[13px] font-medium text-accent-600 hover:underline disabled:opacity-50 dark:text-accent-400"
          >
            {avatarBase64 ? 'Change photo' : 'Add photo'}
          </button>
          {avatarBase64 && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={pending}
              className="text-[13px] font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              Remove
            </button>
          )}
        </div>
        {error && <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
      <input ref={inputRef} type="file" accept="image/*" onChange={handleFileSelected} className="hidden" />
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/AvatarUpload.tsx
git commit -m "Add AvatarUpload component"
```

---

## Task 8: Admin "My Profile" on the Team page

**Files:**
- Modify: `crm-frontend/src/pages/Team.tsx`

**Interfaces:**
- Consumes: `AvatarUpload` (Task 7); `UPDATE_USER_PROFILE` (Task 5); `useAuth()`'s `user`/`refetchUser` (Task 6); existing `graphqlRequest`, `Card`, `Button`, `Input`, `Banner`.

- [ ] **Step 1: Add imports**

In `crm-frontend/src/pages/Team.tsx`, add:

```tsx
import { useAuth } from '../context/AuthContext';
import { AvatarUpload } from '../components/ui/AvatarUpload';
import { graphqlRequest } from '../lib/graphql';
import { UPDATE_USER_PROFILE } from '../lib/queries';
```

- [ ] **Step 2: Add state and handlers**

Inside the `Team()` function, alongside the existing `useState` calls (after `const { rows: tasks } = useRealtimeTasks();`):

```tsx
  const { user, refetchUser } = useAuth();
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(user?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
```

Add handler functions (near the existing `copyCode`/`requestJoin` functions):

```tsx
  async function saveName() {
    setSavingName(true);
    setProfileError(null);
    try {
      await graphqlRequest(UPDATE_USER_PROFILE, { name });
      await refetchUser();
      setEditingName(false);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Could not update your name.');
    } finally {
      setSavingName(false);
    }
  }

  async function saveAvatar(avatarBase64: string | null) {
    await graphqlRequest(UPDATE_USER_PROFILE, { avatarBase64 });
    await refetchUser();
  }
```

- [ ] **Step 3: Add the "My Profile" card**

Add a new `Card` as the first item inside the `<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">` wrapper (right after that opening tag, before the existing "Invite your team" `Card`):

```tsx
        <Card className="p-5 lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600/10 text-accent-600 dark:bg-accent-400/15 dark:text-accent-400">
              <IconUser className="h-4 w-4" />
            </span>
            <h2 className="text-[15px] font-semibold text-ink dark:text-white">My profile</h2>
          </div>

          <AvatarUpload
            avatarBase64={user?.avatarBase64 ?? null}
            fallbackInitial={(user?.name?.trim() || user?.email || '?').charAt(0).toUpperCase()}
            onChange={saveAvatar}
          />

          <div className="mt-4">
            {!editingName ? (
              <div className="flex items-center gap-3">
                <p className="text-[13.5px] text-ink dark:text-white">
                  {user?.name?.trim() || 'No name set'}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setName(user?.name ?? '');
                    setEditingName(true);
                  }}
                >
                  Edit name
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                <Button size="sm" onClick={saveName} loading={savingName}>
                  Save
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setEditingName(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>

          {profileError && (
            <div className="mt-3">
              <Banner tone="error">{profileError}</Banner>
            </div>
          )}
        </Card>

```

- [ ] **Step 4: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Run: `cd crm-frontend && npm run dev`. Log in as an admin, open the Team page. Expected: a "My profile" card appears above "Invite your team", showing the current name (or "No name set") and an avatar circle (initial, since no photo yet). Click "Edit name", change it, save — confirm it updates immediately and persists across a reload. Click the avatar, pick a photo — confirm it appears resized/cropped to a square. Click "Change photo" and pick a different one — confirm it replaces the first. Click "Remove" — confirm it falls back to the initial circle.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Team.tsx
git commit -m "Add admin My Profile section (name + avatar) to Team page"
```

---

## Task 9: Member avatar in `MemberProfileView`

**Files:**
- Modify: `crm-frontend/src/components/member/MemberProfileView.tsx`

**Interfaces:**
- Consumes: `AvatarUpload` (Task 7); `EDIT_MEMBER_PROFILE` (Task 5, already imported in this file); `useMemberSession()`'s `updateMember` (existing, already used in this file).

- [ ] **Step 1: Add the import**

```tsx
import { AvatarUpload } from '../ui/AvatarUpload';
```

- [ ] **Step 2: Add the handler**

Inside `MemberProfileView`, after the existing `handleSave` function:

```tsx
  async function saveAvatar(avatarBase64: string | null) {
    await graphqlRequest(EDIT_MEMBER_PROFILE, { uuid: member.uuid, avatarBase64 });
    updateMember({ avatarBase64 });
  }
```

- [ ] **Step 3: Replace the static initial circle with `AvatarUpload`**

Replace this block (inside the `!editing` branch, the `<div className="flex flex-col items-center text-center">` section):

```tsx
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-accent-600 to-accent-800 text-[30px] font-bold text-white shadow-sm">
                  {initial}
                </div>
```

with:

```tsx
                <AvatarUpload
                  avatarBase64={member.avatarBase64 ?? null}
                  fallbackInitial={initial}
                  onChange={saveAvatar}
                />
```

(`AvatarUpload` renders its own circle + controls, replacing the plain static circle; the surrounding `flex flex-col items-center text-center` wrapper stays as-is.)

- [ ] **Step 4: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Log in to the member portal (`/portal/login`), open the profile tab. Expected: `AvatarUpload`'s circle/controls appear where the static initial circle used to be. Add, change, and remove a photo — confirm each persists across a reload (re-fetching `currentMember` on the member portal's own session-restore path).

- [ ] **Step 6: Commit**

```bash
git add src/components/member/MemberProfileView.tsx
git commit -m "Add avatar upload to MemberProfileView"
```

---

## Task 10: Sidebar avatar

**Files:**
- Modify: `crm-frontend/src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: `useAuth()`'s `user.avatarBase64` (already available via `user` from `useAuth()`, already destructured in this file).

- [ ] **Step 1: Render the photo when present**

Replace this block (the identity circle near the bottom of the file):

```tsx
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink/10 text-[13px] font-semibold text-ink/60 dark:bg-white/10 dark:text-white/70">
          {initial}
        </div>
```

with:

```tsx
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/10 text-[13px] font-semibold text-ink/60 dark:bg-white/10 dark:text-white/70">
          {user?.avatarBase64 ? (
            <img src={user.avatarBase64} alt="" className="h-full w-full object-cover" />
          ) : (
            initial
          )}
        </div>
```

- [ ] **Step 2: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: zero errors — this was the last site referencing `AppUser`/`Member` without accounting for `avatarBase64`.

- [ ] **Step 3: Manual verification**

With a photo already set (from Task 8's verification), confirm it now also renders in the sidebar's identity circle at the bottom, replacing the initial. Remove the photo — confirm the sidebar falls back to the initial again.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "Show the admin's avatar in the sidebar"
```

---

## Self-Review Notes

- **Spec coverage:** storage design (Task 1's columns, deliberately outside Supabase Auth metadata per the spec's rationale), size limit (Task 2, enforced both client-side in `AvatarUpload`'s canvas resize and server-side in `validateAvatarBase64`), backend mutations (Tasks 3-4, both using "omit vs. explicit null" semantics), frontend `AvatarUpload` reused in both consumers (Tasks 7-9), Sidebar integration (Task 10). Member roster/mention avatars are explicitly not touched anywhere in this plan, matching the spec's stated exclusion.
- **Type consistency:** `avatarBase64: string | null` used identically across the GraphQL schema (Tasks 3-4), the backend `mapUser`/`mapMember` shapes, the frontend `AppUser`/`Member` types (Task 5), and every component that reads or writes it (Tasks 7-10) — always `avatarBase64`, never `avatar`/`photoUrl`/other names.
- **No placeholders:** every step has complete, real code — no TBD/TODO, no "similar to Task N" shortcuts. Verified (Task 5) that adding fields to `AppUser`/`Member` doesn't break the build at any intermediate step, since neither type is ever constructed as a literal outside of type-cast GraphQL responses — so every task's `tsc -b` check can honestly expect a clean compile, not an assumed-broken intermediate state.
