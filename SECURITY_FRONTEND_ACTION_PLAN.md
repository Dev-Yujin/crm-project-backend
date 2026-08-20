# Security Action Plan — Frontend (crm-frontend)

Companion to [SECURITY_BACKEND_ACTION_PLAN.md](./SECURITY_BACKEND_ACTION_PLAN.md) (the findings) and [MEMBER_SECURITY_INTEGRATION.md](./MEMBER_SECURITY_INTEGRATION.md) (the full backend contract). This doc is the concrete punch list for `crm-frontend` — exact files, exact changes, based on reading the actual current source.

**All of this is deployed backend-side already.** Until these frontend changes ship, real members cannot log in or do anything member-facing — `loginMember` no longer returns a token to store, and every member operation requires the httpOnly cookie this doc wires up.

| # | Change | File(s) | Severity |
|---|---|---|---|
| 1 | `graphqlRequest` must send cookies | `src/lib/graphql.ts` | **Blocking** — nothing member-facing works without this |
| 2 | Member session must stop using `localStorage` | `src/context/MemberSessionContext.tsx` | **Blocking** — this is the exact `crm-member-token` localStorage key the original report was about |
| 3 | `loginMember`/`currentMember` query shapes changed | `src/lib/queries.ts`, `src/types/index.ts` | **Blocking** — old shape will throw a TS/runtime mismatch |
| 4 | Add a real logout call | `src/context/MemberSessionContext.tsx` | High — without it, `logoutMember`'s cookie-clearing never happens |
| 5 | Handle self-password-change forcing a re-login | `src/components/member/MemberProfileView.tsx` | Medium — otherwise the member silently loses their session mid-use |

Everything else (`EDIT_MEMBER_PROFILE`, `SUBMIT_TASK`, `EDIT_TASK` operation strings) needs **no changes** — see "What didn't change" below.

---

## 1. `src/lib/graphql.ts` — send cookies on every request

Current:

```ts
const res = await fetch(GRAPHQL_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(session?.access_token && { Authorization: `Bearer ${session.access_token}` }),
  },
  body: JSON.stringify({ query, variables }),
});
```

Add `credentials: 'include'`:

```ts
const res = await fetch(GRAPHQL_URL, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    ...(session?.access_token && { Authorization: `Bearer ${session.access_token}` }),
  },
  body: JSON.stringify({ query, variables }),
});
```

Without this, the browser won't send the member cookie back to the API (frontend and backend are different origins even in local dev — different ports), and won't store it on `loginMember` either. Safe to set unconditionally on every call — it does nothing for user-session requests (Supabase auth is unaffected, still via the `Authorization` header) and only matters when a member cookie exists.

This alone won't work yet — it also requires the backend's `FRONTEND_ORIGIN` to list this app's exact origin (already configured backend-side for `http://localhost:5173` and the production domain; flag it if you deploy a new preview/staging URL, since the backend has to allow it by name — wildcard origins are incompatible with cookie auth).

## 2. `src/context/MemberSessionContext.tsx` — drop localStorage entirely

Current file (the whole thing, for reference):

```ts
const TOKEN_KEY = 'crm-member-token';
// ... useEffect reads localStorage, calls CURRENT_MEMBER with { token }
// ... login() calls LOGIN_MEMBER, does localStorage.setItem(TOKEN_KEY, loginMember.token)
// ... logout() just clears local state + localStorage
```

Rewrite to:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { graphqlRequest } from '../lib/graphql';
import { LOGIN_MEMBER, LOGOUT_MEMBER, CURRENT_MEMBER } from '../lib/queries';
import type { Member, MemberAuthPayload } from '../types';

interface MemberSessionContextValue {
  member: Member | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ error: string | null }>;
  logout: () => void;
  updateMember: (patch: Partial<Member>) => void;
}

const MemberSessionContext = createContext<MemberSessionContextValue | null>(null);

export function MemberSessionProvider({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // No stored token to check for anymore — just ask the API. If a valid
    // session cookie exists, this resolves; if not, it throws and we're
    // simply logged out. No error is shown for this case — it's the normal
    // "nobody's logged in yet" state on first load.
    graphqlRequest<{ currentMember: Member | null }>(CURRENT_MEMBER)
      .then(({ currentMember }) => setMember(currentMember))
      .catch(() => setMember(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    try {
      const { loginMember } = await graphqlRequest<{ loginMember: MemberAuthPayload }>(
        LOGIN_MEMBER,
        { email, password },
      );
      // No token to store — the Set-Cookie response header already did that,
      // invisibly, as part of this same request.
      setMember(loginMember.member);
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Invalid email or password.' };
    }
  }

  async function logout() {
    setMember(null);
    // Fire-and-forget is fine here — the client-side state is already cleared
    // either way, this just makes sure the cookie dies server-side too.
    try {
      await graphqlRequest(LOGOUT_MEMBER);
    } catch {
      // ignore — logging out client-side still succeeds even if this fails
    }
  }

  function updateMember(patch: Partial<Member>) {
    setMember((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  return (
    <MemberSessionContext.Provider value={{ member, loading, login, logout, updateMember }}>
      {children}
    </MemberSessionContext.Provider>
  );
}

export function useMemberSession() {
  const ctx = useContext(MemberSessionContext);
  if (!ctx) throw new Error('useMemberSession must be used within MemberSessionProvider');
  return ctx;
}
```

Note `logout` is now `async` — check any callers (e.g. a logout button's `onClick`) still work if they weren't already awaiting it; a plain `onClick={logout}` still works fine since React doesn't care whether the handler returns a promise.

## 3. `src/lib/queries.ts` and `src/types/index.ts` — updated shapes

`queries.ts` currently:

```ts
export const LOGIN_MEMBER = `
  mutation LoginMember($email: String!, $password: String!) {
    loginMember(email: $email, password: $password) {
      member { uuid username email groupId createdAt }
      token
    }
  }
`;

export const CURRENT_MEMBER = `
  query CurrentMember($token: String!) {
    currentMember(token: $token) { uuid username email groupId createdAt }
  }
`;
```

Change to:

```ts
export const LOGIN_MEMBER = `
  mutation LoginMember($email: String!, $password: String!) {
    loginMember(email: $email, password: $password) {
      member { uuid username email groupId createdAt }
    }
  }
`;

export const CURRENT_MEMBER = `
  query CurrentMember {
    currentMember { uuid username email groupId createdAt }
  }
`;

export const LOGOUT_MEMBER = `
  mutation LogoutMember {
    logoutMember
  }
`;
```

`types/index.ts` currently:

```ts
export interface MemberAuthPayload {
  member: Member;
  token: string; // member JWT, 7-day expiry — separate from the Supabase user session
}
```

Change to:

```ts
export interface MemberAuthPayload {
  member: Member;
}
```

## 4. Logout — covered by #2 above

Just calling `LOGOUT_MEMBER` from `logout()` (as shown in #2) is the whole fix — flagged separately here because it's easy to do #2's localStorage removal and forget this half, and without it the cookie never actually gets cleared (the member would appear logged out in the UI but the cookie would still be live until it naturally expires).

## 5. `MemberProfileView.tsx` — password change ends the session

`handleSave` (around line 57) currently treats a password change exactly like any other profile edit — updates local state, shows a success banner, stays on the page. But changing your own password now bumps `token_version` server-side (see `MEMBER_SECURITY_INTEGRATION.md` → Revocation), which invalidates the *current* session's cookie too, not just other devices'. The member's very next request will come back `UNAUTHENTICATED`.

Detect the password-change case and redirect to login instead of showing an in-place success state:

```tsx
const { updateMember, logout } = useMemberSession(); // add logout here

async function handleSave() {
  if (!username.trim() || !email.trim()) {
    setError('Username and email are required.');
    return;
  }
  setSaving(true);
  setError(null);
  try {
    await graphqlRequest(EDIT_MEMBER_PROFILE, {
      uuid: member.uuid,
      username,
      email,
      ...(password ? { password } : {}),
    });
    if (password) {
      // Own session cookie is now invalid — this call already looked
      // successful, but the next authenticated request would 401 anyway,
      // so send them to log in with the new password now.
      await logout();
      return;
    }
    updateMember({ username, email });
    setPassword('');
    setEditing(false);
    setSuccess(true);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to update profile.');
  } finally {
    setSaving(false);
  }
}
```

Whatever routes to the login screen when `member` becomes `null` (should already exist, since that's the normal logged-out state) will pick this up automatically once `logout()` clears the context's `member` state.

---

## What didn't change (verified against the real backend, not assumed)

Two operations turned out to be used by **both** an admin (via `Members.tsx`, `TaskDetailModal.tsx`, `SubmitOnStatusModal.tsx` — all using the Supabase user session) **and** a member (via `MemberProfileView.tsx`, `MemberTaskModal.tsx` — using the member cookie). Discovering this while implementing caught a regression before it shipped: an early version of the backend fix required member auth unconditionally on these two, which would have broken the admin "edit member" and "record a submission on behalf of" flows entirely. Fixed on the backend to accept either credential:

- **`EDIT_MEMBER_PROFILE`** (`uuid: ID!, username, email, password`) — unchanged shape. When called with a user session, `uuid` is required and must name a member in the caller's own group (`Members.tsx`'s existing call already does this correctly). When called with a member cookie, `uuid` is accepted but ignored — always edits the caller's own profile (`MemberProfileView.tsx`'s existing call, which already sends `uuid: member.uuid`, keeps working — the arg is just redundant now, harmless to leave as-is).
- **`SUBMIT_TASK`** (`taskId: ID!, memberUuid: ID!, link: String!, note: String`) — unchanged shape, same reasoning. Admin calls (`TaskDetailModal.tsx`, `SubmitOnStatusModal.tsx` in its admin-context usage) keep specifying `memberUuid` explicitly. Member calls (`MemberTaskModal.tsx`, `SubmitOnStatusModal.tsx` in its member-context usage) already send `memberUuid: member.uuid` too, which is now ignored server-side in favor of the cookie identity — also harmless to leave as-is.

Both are now scoped to the caller's own group server-side either way (a user can't reach a member outside their group; a member can't touch a task outside their group), which wasn't previously enforced at all.

**`GET_TASKS_FOR_MEMBER`/`tasksForMember` is defined in `queries.ts` but not called anywhere in the app** — `MemberProfileView.tsx` and `MemberTaskModal.tsx` get a member's tasks via `useRealtimeTasksForMember`, which reads `/tasks` directly from Firebase and filters client-side, not through this GraphQL query. Worth knowing: **this means the member task list's actual read path isn't protected by anything in this doc or `MEMBER_SECURITY_INTEGRATION.md` at all** — it goes through the still-open Item 1 in `SECURITY_BACKEND_ACTION_PLAN.md` (world-readable Firebase RTDB). No frontend action needed here specifically, but it's a reason Item 1 matters more than it might look from the GraphQL side alone.

## Verification checklist

- [ ] `credentials: 'include'` added to `graphqlRequest`'s fetch call
- [ ] `MemberSessionContext.tsx` no longer imports/uses `localStorage` for anything member-related
- [ ] Login → refresh the page → still logged in (via `currentMember`, not a stored token)
- [ ] Log out → refresh the page → logged out, and a new login is required (not just client-state amnesia)
- [ ] Changing your own password redirects to login rather than showing a stale "success" state
- [ ] Admin can still edit a member's profile from `Members.tsx`
- [ ] Admin can still record a submission on behalf of a member from `TaskDetailModal.tsx` / the admin path of `SubmitOnStatusModal.tsx`
- [ ] A member can still submit their own work and edit their own profile from the member portal
- [ ] TypeScript compiles clean after removing `token` from `MemberAuthPayload`
