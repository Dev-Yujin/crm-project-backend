# Member Auth Hardening — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md), which covers setup, auth, and the `graphqlRequest` helper — use that as the base. This doc covers a security fix driven by [SECURITY_BACKEND_ACTION_PLAN.md](./SECURITY_BACKEND_ACTION_PLAN.md) items 2–4 and 5: member-facing operations previously required **no authentication at all**, and the member token's transport has changed since an earlier pass at this fix.

**Status: deployed. This is a breaking change for the member portal — read this before anything else breaks silently.**

**If you already started building against a `token` field returned from `loginMember` and an `Authorization` header — stop, that was an intermediate design. It's been superseded by the httpOnly cookie approach below before any frontend code shipped against it.** The problem it was trying to solve (no auth at all on member operations) is the same; the transport is different and stronger.

## What was wrong

Two separate problems, fixed in one pass:

1. `tasksForMember`, `editTask`, and `submitTask` took a `memberUuid` argument and trusted it completely — there was no session, no token, nothing. Anyone who could read a member's uuid out of the (also unauthenticated) Firebase mirror could call these directly against the GraphQL endpoint and read that member's tasks or write submissions/edits as them, with zero login. `editMemberProfile` was worse — no argument was even verified, so any caller could rewrite any member's username/email/password by uuid alone.
2. Even once a real member JWT existed, the original design (`loginMember` returning `token` in the response body) meant the frontend would store that token somewhere JavaScript can read — `localStorage`, a JS variable, etc. Anyone who got script execution on the page (XSS) could just read it out and impersonate that member for as long as the token stayed valid. This is what the "paste the token into DevTools" concern (item 5 in the security doc) was really about — the token itself is fine, but nothing stopped it from being lifted.

## What changed

| Operation | Before | Now |
|---|---|---|
| `loginMember` | returned `token` in the response body | **`MemberAuthPayload` no longer has a `token` field at all.** The token is set as an `httpOnly` cookie in the response — invisible to page JavaScript, including XSS. Response body only has `member` |
| `logoutMember` | didn't exist | **new mutation** — clears the auth cookie server-side. Required now, since a client can't clear an httpOnly cookie itself |
| `tasksForMember` | no auth, `memberUuid` arg trusted | **requires the member cookie**; `memberUuid` arg accepted but ignored — always resolves to the caller's own tasks |
| `submitTask` | no auth, `memberUuid` arg trusted | **requires either a user session or the member cookie** — turned out to be used by both an admin recording a submission on behalf of an assignee (`memberUuid` required and meaningful there) and a member submitting their own work (`memberUuid` accepted but ignored, resolved from the cookie instead) |
| `editTask` | no auth at all | **requires either a user session or the member cookie** — this mutation is used by both the admin task board (`clientId`, `assignedMembers`, `departmentId`, `assignedUsers`, ...) and a member's own update flow, so either credential works; the task must belong to the caller's own group either way |
| `currentMember` | `token` arg only | **reads the member cookie automatically**; a `token` arg still exists as a fallback for non-browser callers (scripts, tests) — nothing in the browser app should ever populate it, since the public API no longer hands out a raw token to put there |
| `editMemberProfile` | no auth, `uuid` arg trusted | **requires either a user session or the member cookie** — also turned out to be used by both an admin editing a member they manage (`uuid` required, scoped to the caller's own group) and a member editing their own profile (`uuid` accepted but ignored, resolved from the cookie instead) |
| `loginMember` | no rate limiting | rate-limited (5 attempts / 15 min per email) |
| Member JWT | 7-day expiry, no revocation | **1-day expiry**; carries a `tokenVersion` that's checked against the member row on every request — see Revocation below |

## What you must do

**Three changes to the member portal:**

1. **Every fetch to the GraphQL endpoint from the member portal must include `credentials: 'include'`.** This is what makes the browser attach the cookie. If your `graphqlRequest` helper hardcodes `credentials: 'omit'` or leaves it unset (defaults to `'same-origin'`, which won't send the cookie cross-origin during local dev where frontend and backend run on different ports), add `credentials: 'include'` specifically for member-portal calls.
2. **Stop reading/storing `loginMember`'s `token` field — it doesn't exist anymore.** After a successful `loginMember` call, the member is authenticated; there's no value to persist yourself. Use the returned `member` object directly for display, and call `currentMember` (also cookie-based) to restore the session on app reload instead of restoring from a stored token.
3. **Call the new `logoutMember` mutation on logout**, instead of (or in addition to, doesn't hurt) whatever local cleanup you were doing before — it's the only way to actually clear the httpOnly cookie.

**Until this ships, real members will get `UNAUTHENTICATED` errors on `tasksForMember`, `editTask`, `submitTask`, `currentMember`, and `editMemberProfile`.** There's no way to soften this rollout further — deploy the frontend change promptly.

For the exact file-by-file diff against the real `crm-frontend` source (not a generic sketch), see [SECURITY_FRONTEND_ACTION_PLAN.md](./SECURITY_FRONTEND_ACTION_PLAN.md).

## Revocation

Every member row now has a `tokenVersion`. It's embedded in the JWT at login and checked against the row on every request — bumping the row's version invalidates every outstanding token for that member immediately, no waiting for expiry.

Two things bump it automatically:
- **The member changes their own password** via `editMemberProfile` — this means changing your password logs you out everywhere, including the current session. Expect to redirect to the member login screen right after a successful password change, not back into the app.
- **An admin calls the new `revokeMemberSessions(uuid: ID!): Boolean!` mutation** (user auth required, same group ownership check as `deleteMember`) — use this for a "log this member out everywhere" button, e.g. if a member's device is lost or their access needs to be pulled immediately.

## TypeScript / operations

Add to `FRONTEND_INTEGRATION.md`'s existing member operations (already updated in place in §4/§6 — this is just the delta explained):

```ts
// No token to store anymore — member is authenticated once this resolves without error.
// Make sure this fetch (and every member-portal fetch below) sets credentials: 'include'.
const LOGIN_MEMBER = `
  mutation LoginMember($email: String!, $password: String!) {
    loginMember(email: $email, password: $password) {
      member { uuid username email groupId createdAt }
    }
  }
`;

const LOGOUT_MEMBER = `
  mutation LogoutMember {
    logoutMember
  }
`;

// currentMember and editMemberProfile no longer take the identity as an argument —
// both are now unconditionally "the caller from the cookie."
const CURRENT_MEMBER = `
  query CurrentMember {
    currentMember { uuid username email groupId createdAt }
  }
`;

const GET_TASKS_FOR_MEMBER = `
  query GetTasksForMember {
    tasksForMember { id taskName taskDescription statusId departmentId groupId /* ...rest as before */ }
  }
`;

const SUBMIT_TASK = `
  mutation SubmitTask($taskId: ID!, $link: String!, $note: String) {
    submitTask(taskId: $taskId, link: $link, note: $note) {
      id submission { link note submittedBy submittedAt }
    }
  }
`;

const EDIT_MEMBER_PROFILE = `
  mutation EditMemberProfile($username: String, $email: String, $password: String) {
    editMemberProfile(username: $username, email: $email, password: $password) {
      uuid username email groupId createdAt
    }
  }
`;

// Admin-only — force logout a member from every device.
const REVOKE_MEMBER_SESSIONS = `
  mutation RevokeMemberSessions($uuid: ID!) {
    revokeMemberSessions(uuid: $uuid)
  }
`;
```

`editTask` itself is unchanged in shape — same args as documented in `FRONTEND_INTEGRATION.md` §6 — it just now requires auth (user session or member cookie, whichever the caller has). It's a normal user-portal request otherwise, so it doesn't need `credentials: 'include'` unless it's being called from the member portal.

## Why a cookie, and what it needs from CORS

`httpOnly` means page JavaScript literally cannot read the cookie — `document.cookie` won't show it, and no XSS payload running in the page can exfiltrate it, unlike the old `localStorage`-based design. The browser still attaches it automatically on requests to this API, which is why `credentials: 'include'` is required — without it, the browser won't send cookies cross-origin (and frontend/backend are cross-origin even in local dev, different ports).

For this to work, the backend's CORS config must name your frontend's exact origin(s) — it can't be `*` when credentials are involved, browsers reject that combination. That's already configured server-side via `FRONTEND_ORIGIN` (comma-separated). If you add a new frontend deployment URL (a preview environment, a new domain), that env var needs to be updated on the backend, not something you can work around from the frontend side.

## Verification checklist

- [x] `loginMember` response body contains no `token` field; `Set-Cookie` response header sets `memberToken` with `HttpOnly`
- [x] `tasksForMember`, `editTask`, `submitTask`, `editMemberProfile` with no cookie/header → `UNAUTHENTICATED`
- [x] `tasksForMember` succeeds using only the cookie (no Authorization header at all)
- [x] `editTask` with a **user** session succeeds (admin task board keeps working)
- [x] `editTask` with a **member** cookie succeeds
- [x] `submitTask` with a **user** session and an explicit `memberUuid` succeeds (admin "record a submission on behalf of" flow keeps working)
- [x] `submitTask` with a **member** cookie succeeds, ignoring any `memberUuid` sent alongside it
- [x] `editMemberProfile` with a **user** session and an explicit `uuid` succeeds, and is rejected for a `uuid` outside the caller's own group (admin "edit member" flow keeps working)
- [x] `editMemberProfile` with a **member** cookie ignores a forged `uuid` argument — only ever edits the caller's own row
- [x] `tasksForMember` ignores a forged `memberUuid` argument — resolves via the cookie identity regardless of what's passed
- [x] `logoutMember` clears the cookie (`Set-Cookie` with an expired/empty value)
- [x] Repeated failed `loginMember` attempts get rate-limited
- [x] `revokeMemberSessions` requires a user session (group-scoped) to call
- [x] After revocation (or a password change), the member's existing cookie is rejected — they must log in again
- [x] A preflight request from a disallowed origin gets no `Access-Control-Allow-Origin` header (browser blocks the real request)

All verified live against the real database as of this doc's writing.

## Deployment requirements (backend, for awareness — not a frontend task)

- `NODE_ENV=production` must be set on the real deployment, or the cookie won't get the `Secure` flag and could be sent over plain HTTP.
- `FRONTEND_ORIGIN` must list every real frontend origin that needs to authenticate (comma-separated).
- If the frontend and backend end up on genuinely unrelated domains (not subdomains of the same site), `COOKIE_SAME_SITE=none` needs to be set too — that also requires HTTPS everywhere, since `SameSite=None` cookies are rejected by browsers without `Secure`.

## Not covered by this doc

This closes items 2, 3, 4, and 5 in `SECURITY_BACKEND_ACTION_PLAN.md`, except the refresh-token note below. **Not** done:
- **Item 1 — Firebase RTDB security rules.** The database is still world-readable over plain HTTPS. This needs an architecture decision (mint Firebase custom tokens for members, or move the backend off the Firebase client SDK onto the Admin SDK with a service account) before rules can be written and deployed safely — see the main conversation / `SECURITY_BACKEND_ACTION_PLAN.md` §1 for the tradeoffs.
- **Item 4's TTL note** — the doc suggests a short access token + refresh token pair as the long-term shape; this pass only shortened the flat TTL from 7 days to 1 day as a stopgap, it did not add refresh tokens.
