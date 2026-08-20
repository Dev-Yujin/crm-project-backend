# Security Action Plan — Backend

**Written 2026-08-20. All findings verified against the live production system.**
No real data was modified: write probes used a non-existent task id, so they prove the
auth gate is missing without changing anything.

> **The reported concern — "you can bypass login by pasting `crm-member-token` into
> DevTools" — is real but is the *least* severe issue here.** That token is actually
> validated server-side (`currentMember(token)`), so a made-up token fails. It doesn't
> matter, because **the endpoints underneath require no token at all.** An attacker
> never needs to touch the frontend.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Firebase RTDB is world-readable | **Critical** | Verified |
| 2 | `tasksForMember` returns data unauthenticated | **Critical** | Verified |
| 3 | `editTask` / `submitTask` accept a self-declared `memberUuid`, unauthenticated | **Critical** | Verified |
| 4 | Member token has no revocation, 7-day TTL, passed as a GraphQL argument | High | Verified |
| 5 | Supabase admin session sits in `localStorage` (framework default) | Low–Medium | Expected behaviour — see frontend plan §0 |

---

## The chain, end to end

These compose into full unauthenticated read **and write** access, with no login of any kind:

```
1. Read the RTDB over plain HTTPS         -> every member uuid, client, task, chat, note
2. tasksForMember(<uuid>)                 -> that member's tasks, no auth
3. editTask / submitTask(memberUuid: …)   -> write as any member, no auth
```

Step 1 supplies the uuids that steps 2 and 3 need. Fixing any one link helps; fixing
2 and 3 without 1 still leaves all data readable.

---

## 1. Firebase RTDB is world-readable — **Critical**

A plain HTTPS GET against the database URL, **with no credentials**, returns the entire
database. Confirmed collections: `tasks`, `clients`, `groups`, `departments`,
`services`, `taskStatuses`, `recurringTasks`, `notifications`, `calendarEntries`.

That includes client names, task descriptions, and — because the app stores them there —
inquiries, chat messages, and meeting notes.

The database URL ships inside the client bundle (`VITE_FIREBASE_DATABASE_URL`), so it is
public by construction. **Anyone who loads your site can read everything.**

**Fix.** Security rules that require an authenticated principal and scope every read to
the caller's own `groupId`, mirroring what GraphQL already enforces. Roughly:

```jsonc
{
  "rules": {
    ".read": false,
    ".write": false,
    "tasks": {
      ".indexOn": ["groupId"],
      "$taskId": {
        ".read":  "auth != null && data.child('groupId').val() === root.child('userGroups').child(auth.uid).val()",
        ".write": "auth != null && ..."
      }
    }
  }
}
```

Two things to settle first, because they shape the rules:

- **Members don't have Firebase auth.** They hold a custom member JWT, not a Firebase
  credential. Options: mint **Firebase custom tokens** for members at login (cleanest —
  gives every principal a real `auth.uid` and makes `auth != null` meaningful), or route
  member reads through GraphQL and keep RTDB admin-only.
- **Write rules matter as much as read.** I deliberately did **not** test whether the
  database is writable — that would mean writing to your production data. **Please check
  this yourself; unauthenticated write would be materially worse than read**, since it
  would allow planting content that other users' browsers then render.

---

## 2 & 3. Member operations are unauthenticated — **Critical**

`FRONTEND_INTEGRATION.md` documents this as intentional:

> Members currently have **no login/session mechanism**, so member-facing mutations
> (`submitTask`, `editTask`) are unauthenticated and take a `memberUuid` argument directly.

That predates the member portal. **Members now do have a login** (`loginMember` returns a
JWT), so the assumption no longer holds — but the resolvers were never tightened.

**Verified, unauthenticated, against production:**

```
{ tasksForMember(memberUuid: "<real uuid>") { id taskName clientName } }
  -> returned real task data                          ⚠️  no auth

mutation { editTask(taskId: "__nonexistent__", …) }
  -> "Task not found"    (reached the resolver)       ⚠️  no auth
mutation { submitTask(taskId: "__nonexistent__", …) }
  -> "Task not found"    (reached the resolver)       ⚠️  no auth
mutation { reviewTask(taskId: "__nonexistent__", …) }
  -> UNAUTHENTICATED                                  ✓ correctly gated
```

`reviewTask` proves the gate exists and works — it simply was never applied to the
member operations.

**Fix.** Require the member JWT on every member operation and **derive `memberUuid` from
the token instead of accepting it as an argument.**

```graphql
# before — caller asserts who they are
submitTask(taskId: ID!, memberUuid: ID!, link: String!, note: String): Task

# after — identity comes from the verified token
submitTask(taskId: ID!, link: String!, note: String): Task
```

While `memberUuid` remains an argument, any authorisation check can be defeated by
passing someone else's uuid. Same for `tasksForMember` — it should become
`myTasks` with no argument at all.

Also enforce: the task must belong to the caller's group, and for `submitTask` the
caller should be among its `assignedMembers`.

**Coordinate the rollout** — removing the argument is breaking. Suggested order: accept
the token and ignore `memberUuid` when present → frontend stops sending it → drop the
argument.

---

## 4. Member token hygiene — High

- **Passed as a GraphQL argument** (`currentMember(token: $token)`) rather than an
  `Authorization` header. Arguments land in query logs, APM traces, and error reports.
  Move it to a header.
- **No revocation.** A leaked token is valid for its full 7 days and cannot be killed.
  Add a `tokenVersion` on the member row, embed it in the JWT, and reject on mismatch —
  bumping it invalidates every outstanding token for that member.
- **7-day TTL is long** for a bearer token in `localStorage`. A short access token plus
  a refresh token is the standard shape.
- **Add rate limiting** on `loginMember` — there is nothing to stop credential stuffing.

---

## Suggested order

1. **RTDB security rules** — biggest exposure, no API change, deployable independently.
2. **Auth on `tasksForMember` / `editTask` / `submitTask`** — accept the token first,
   ignore `memberUuid`, then drop the argument once the frontend stops sending it.
3. **Token hygiene** — header, revocation, shorter TTL, login rate limit.

Items 1 and 2 are independent and can proceed in parallel.
