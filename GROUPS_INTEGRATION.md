# Groups — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md), which still covers setup, auth, and the `graphqlRequest` helper — use that as the base. This doc covers how multi-tenant data isolation ("groups") works and how a user joins a teammate's group.

## How it works

Every piece of data in this system — `clients`, `tasks`, `members`, `departments`, `services`, `taskStatuses`, `recurringTasks` — belongs to exactly one **group**. A signed-in user only ever sees their own group's data; this is what keeps one team's records invisible to another.

**Group creation is fully automatic and happens outside GraphQL entirely.** A Postgres trigger on `auth.users` fires the instant a new Supabase Auth account is created — no matter how it was created (email/password through `registerUser`, Google OAuth straight from the frontend, anything) — and provisions a brand-new group + a random 8-character join code for that user. There is no `createGroup` mutation and never needs to be one; by the time a user can make their first authenticated request, they already belong to a group.

```
New Supabase Auth account created (any method)
        │
        │  Postgres trigger fires automatically
        ▼
   groups row inserted: { groupId: <new>, userId: <them>, join_code: <random> }
        │
        ▼
   Every subsequent authenticated request resolves their groupId from this row
```

To collaborate with someone instead of working alone, a user calls **`joinGroup(joinCode)`** with a code a teammate shares with them (that teammate gets their own code from `myGroup`). This **switches** the calling user into that group — it is not additive and does not merge groups:

- Before: `{ groupId: A, userId: me, join_code: "AAAA1111" }`
- After `joinGroup("BBBB2222")`: `{ groupId: B, userId: me, join_code: "BBBB2222" }` — same row, just repointed

Whatever existed under the user's own auto-created group (group A above) is left behind, orphaned — nobody belongs to it anymore. In practice this only matters if the user had already created clients/tasks/etc. before joining a team, so treat "join a team" as something a brand-new user does immediately after signing up, not a casual toggle to flip later.

A user belongs to **exactly one** group at all times. `joinGroup` never fails with an "already in a group" error — everyone always has one, so joining just means switching.

## Auth

| Operation | Type | Auth required | Notes |
|---|---|---|---|
| `myGroup` | Query | **user** | returns your current `{ groupId, joinCode }`. Every account has one from signup, so this should never return `null` in normal use |
| `joinGroup(joinCode)` | Mutation | **user** | switches you into the code's group; only fails if the code is invalid |

Send `Authorization: Bearer <session.access_token>` via `graphqlRequest` from §3 of the main doc, same as every other user-authenticated call.

You may occasionally see a GraphQL error with `extensions.code === 'NO_GROUP'` on *other* group-scoped operations (tasks, clients, etc.) — since signup guarantees a group, this shouldn't happen for any normal account and is worth treating as a bug report rather than a state to design a screen around.

## TypeScript types

```ts
export interface Group {
  groupId: string;
  joinCode: string; // share this with teammates so they can joinGroup with it
}
```

## Operations

```ts
const MY_GROUP = `
  query MyGroup {
    myGroup { groupId joinCode }
  }
`;

// Moves the signed-in user into the group that owns this code — e.g. a teammate
// shares their joinCode (from their own MY_GROUP) and this user pastes it in to
// join them instead of staying in their own solo, auto-created group.
const JOIN_GROUP = `
  mutation JoinGroup($joinCode: String!) {
    joinGroup(joinCode: $joinCode) { groupId joinCode }
  }
`;
```

There's no "leave group" or "regenerate code" mutation — a join code is permanent and reusable (anyone with it can join, repeatedly, at any time), so treat it like a shared invite link, not a one-time secret.

## Suggested UI

- A **"Team" / "Settings → Group"** screen: call `MY_GROUP` and display the `joinCode` prominently (with a copy button) so the user can hand it to teammates.
- A **"Join a team"** input (join code field + submit button) somewhere reachable early — ideally right after first sign-in, before the user has created any real clients/tasks, since joining later abandons whatever they'd already built under their own auto-created group.
- Nothing to build for "create a group" — it already happened by the time the user is looking at your app.
