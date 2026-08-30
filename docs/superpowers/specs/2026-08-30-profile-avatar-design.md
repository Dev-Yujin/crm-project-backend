# Admin & Member Name/Avatar Editing — Design

## Problem

Neither an admin (Supabase Auth user) nor a member has any way to set a display name beyond signup or add a profile picture. `Sidebar.tsx` and every roster/mention UI shows a plain initial-letter circle. Members can already edit `username`/`email`/`password` via `editMemberProfile`; admins have no self-editing mutation at all today — `userTypeDefs.js` exposes `id, email, name` on `User` with no way to change any of them post-registration.

## Scope

Add: an admin-editable name, and an add/edit/delete profile picture for both admins and members. Nothing else — no change to `editMemberProfile`'s existing username/email/password behavior, no change to registration/login flows.

## Storage design — why the avatar doesn't live where the name does

Admin's `name` already lives in Supabase Auth's `user_metadata` (set once at `registerUser` via `options: { data: { name } }`, read back in `resolvers/userResolvers.js`'s `mapUser`). That's fine for a short string — it stays there, updated via a new mutation calling `supabase.auth.updateUser({ data: { name } })`.

The avatar is different: Supabase issues `user_metadata` embedded directly in every access-token JWT for that user. A multi-KB base64 photo living there would inflate every request's auth cookie/header, on every request, for the life of the session — a real performance and cookie-size concern, not a style preference. So the avatar is stored **outside** Supabase Auth entirely:

- Admin avatar: new nullable `text` column, `groups.avatar_base64` — `groups` already has exactly one row per admin (the row keyed by their `userId`), matching the existing pattern of admin-specific data living in that table rather than in `auth.users`.
- Member avatar: new nullable `text` column, `members.avatar_base64`.

Both migrations follow the existing convention established by `scripts/create-group-billing-table.js`: a checked-in, idempotent one-off script, not an in-repo migration framework.

## Size limit

Storing a photo as base64 means the raw bytes live inline in the database and get sent over the wire in every response that includes a profile — unlike a normal upload, there's no separate small-URL indirection. To keep this reasonable: any photo is resized/cropped to a 256×256 square and re-encoded as JPEG (quality ~0.8) **client-side**, before it's ever turned into base64 or sent anywhere. Typical resulting size: 50–150KB. The backend additionally rejects any `avatarBase64` value over a generous cap (300KB) as defense in depth — a client that skips the resize step (a modified client, a bug) can't push an unbounded blob into the database.

## Backend

**Admin** — `typedefs/userTypeDefs.js`:
```graphql
type User {
  id: ID!
  email: String
  name: String
  avatarBase64: String
}

type Mutation {
  "Updates the caller's own name and/or avatar. Omit a field to leave it unchanged;
   pass avatarBase64: null explicitly to remove the photo."
  updateUserProfile(name: String, avatarBase64: String): User!
}
```
Resolver: `requireUser(context)`, validates `avatarBase64` (if provided and non-null) against the size cap, calls `supabase.auth.updateUser({ data: { name } })` when `name` is provided, and a direct `UPDATE groups SET avatar_base64 = $1 WHERE "userId" = $2` when `avatarBase64` is provided (including `null`, which clears it) — mirroring `editMemberProfile`'s pattern of "only touch what's explicitly present in the arguments."

**Member** — `typedefs/memberTypeDefs.js`:
```graphql
type Member {
  # …existing fields…
  avatarBase64: String
}
```
`editMemberProfile` gains an optional `avatarBase64: String` argument, added to the existing dynamic `SET` clause builder in `models/membersFunction.js` (same "only touch what's explicitly present" semantics as above).

Both mutations share the same size-validation helper (a pure function, testable without a DB connection — same spirit as `models/billingLogic.js` from the Stripe work).

## Frontend

One reusable `AvatarUpload` component: click the current avatar (photo or initial-circle) → hidden file input → read via `FileReader` → draw onto an offscreen `<canvas>` sized/cropped to 256×256 → `canvas.toDataURL('image/jpeg', 0.8)` → call the relevant mutation with that full data-URL string as `avatarBase64`. A small "Remove photo" affordance calls the same mutation with `avatarBase64: null`.

Consumers:
- **Admin** — a new "My Profile" section on `Team.tsx` (which currently has no self-editing UI at all): a name input plus `AvatarUpload`, calling `updateUserProfile`.
- **Member** — `MemberProfileView.tsx` gains `AvatarUpload` alongside its existing username/email/password fields, calling the extended `editMemberProfile`.
- **Sidebar** — `Sidebar.tsx`'s existing initial-letter circle renders `<img src={user's avatarBase64}>` when present, falling back to the initial otherwise. (Member-side roster/mention avatars are out of scope for this spec — only the admin's own sidebar identity and the two self-profile screens above.)

## Testing

Backend: `vitest` unit tests for the size-validation helper (accepts a normal-sized string, rejects an oversized one, accepts `null`/`undefined`). No integration test for the mutations themselves — same established convention as the billing DB-access layer (needs a live Postgres/Supabase Auth connection, no test-DB harness in this repo).

Frontend: no test framework (established convention). Manual verification: upload a photo as an admin, confirm it resizes/compresses and appears in the sidebar and Team page; edit it; remove it and confirm fallback to the initial circle; repeat for a member via the member portal; confirm an admin can change their name and it reflects immediately.
