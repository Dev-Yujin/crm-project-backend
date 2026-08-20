# Admin Session Hardening — Frontend Integration Guide

Companion to [MEMBER_SECURITY_INTEGRATION.md](./MEMBER_SECURITY_INTEGRATION.md) and [SECURITY_FRONTEND_ACTION_PLAN.md](./SECURITY_FRONTEND_ACTION_PLAN.md), which cover the member-side fix. This doc covers the same class of problem for the **admin/user session** — the one flagged as item 5 in [SECURITY_BACKEND_ACTION_PLAN.md](./SECURITY_BACKEND_ACTION_PLAN.md) ("Supabase admin session sits in `localStorage`") and originally deprioritized as "expected behaviour." It's been fixed properly now.

**Status: backend deployed and verified locally. One manual step is required before Google sign-in will work anywhere (see below) — do that first.**

## What was wrong

The frontend used `supabase-js` directly (`src/lib/supabase.ts`), with its default settings — session persisted to `localStorage`, refreshed automatically in the browser. Anyone who got script execution on the page (XSS) could read `sb-<project-ref>-auth-token` straight out of `localStorage` and get a fully authenticated admin session — Supabase access token, refresh token, and (for Google sign-in) even Google's own `provider_token`.

This was a materially bigger architectural change than the member-token fix, for two reasons that shaped the approach:

1. Google OAuth's redirect flow, by design, hands the session back to whichever URL you configured as `redirectTo` — if that's a page in the browser, the token exists in browser JS at least once no matter what, unless the *code exchange itself* happens on a server. So closing this required moving the whole OAuth handshake server-side, not just changing where the result gets stored.
2. Supabase's access tokens are short-lived (~1 hour) and need silent refreshing. The old client-side flow used `supabase-js`'s built-in `autoRefreshToken`. Moving to httpOnly cookies means the *server* now needs to be the one refreshing them.

## What changed (backend)

Built on [`@supabase/ssr`](https://www.npmjs.com/package/@supabase/ssr) — the same cookie-based session package Supabase ships for SSR frameworks, wired here into a plain Express request/response instead of a framework's cookie API. It handles session cookies (naming, chunking large tokens across multiple cookies, refreshing) and the OAuth PKCE code-verifier storage, all via cookies your server controls.

| Operation | Before | Now |
|---|---|---|
| `registerUser` / `loginUser` | returned `session { accessToken refreshToken expiresAt }` in the response body | **`AuthPayload` no longer has a `session` field.** The session is set as an httpOnly cookie on the response. Body only has `user` |
| Google sign-in | `supabase.auth.signInWithOAuth()` called directly in the browser; `signInWithGoogle` GraphQL mutation existed but wasn't used | **`signInWithGoogle` mutation removed.** Replaced by a plain redirect: `GET /auth/google` on the API host. The whole PKCE code exchange happens server-side; the browser never sees a token or an OAuth code at any point |
| `currentUser` | `currentUser(accessToken: String!)` — required an explicit token | **`currentUser(accessToken: String)`** — reads the session cookie automatically; the `accessToken` arg is now optional, kept only as a fallback for non-browser callers (scripts, tests) |
| `signOutUser` | signed out of a client-managed `supabase-js` instance | Clears the session cookie server-side — required now, since the browser can't clear an httpOnly cookie itself |
| Access token refresh | handled client-side by `supabase-js`'s `autoRefreshToken` | handled server-side, transparently, on every request — if the cookie's access token is expired, the server uses the cookie's refresh token to get a new one and re-sets the cookie on the same response, before your request even resolves |

## Required manual step — do this first

**Add this backend's OAuth callback URL to the Supabase project's redirect allowlist**, or Google sign-in will fail immediately after the user approves (Supabase will reject the redirect). In the Supabase dashboard: **Authentication → URL Configuration → Redirect URLs**, add:

```
http://localhost:4000/auth/google/callback
https://crm-backend.microdramamarketers.com/auth/google/callback
```

(First for local dev, second for production — add whichever backend URLs you actually use.) This is the one piece of this fix I can't do myself — I don't have dashboard access to your Supabase project.

Also confirm on the **production backend deployment** specifically (not just locally):
- `PUBLIC_BACKEND_URL` is set to the backend's real public URL (e.g. `https://crm-backend.microdramamarketers.com`) — used to build the OAuth callback redirect. Wrong value here means Google sends the user back to the wrong place.
- `NODE_ENV=production` and `FRONTEND_ORIGIN` are set (same requirement as the member fix — see `MEMBER_SECURITY_INTEGRATION.md`).

## Testing limitation, disclosed

I verified the following live, end to end, with real requests: registration, email/password login, cookie-only session restoration (`currentUser` with no argument), a real `requireGroup`-gated query (`myGroup`) working from the cookie alone, sign-out clearing the cookie, and the `/auth/google` route correctly generating a PKCE challenge and redirecting to Supabase with the right callback URL. **I could not click through an actual Google consent screen** — that requires an interactive browser and a real Google account, which isn't something I can drive from here. Once the redirect URL above is registered and the frontend changes below are in place, please do one real Google sign-in yourself to confirm the full round trip.

---

## Frontend changes required

### 1. `src/lib/supabase.ts` — delete it

Nothing else in the codebase needs a direct `supabase-js` client anymore (verified — the only consumers were `AuthContext.tsx`, `AuthCallback.tsx`, and `graphql.ts`, all covered below). Keeping it around is a liability: it's the exact thing that put the session in `localStorage` in the first place, and a future change could easily start using it again out of habit. Delete the file, and `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` become unused too — safe to remove from `.env` once nothing imports this file.

### 2. `src/lib/graphql.ts` — drop the Supabase session lookup

Current:

```ts
export async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token && { Authorization: `Bearer ${session.access_token}` }),
    },
    body: JSON.stringify({ query, variables }),
  });
  // ...
```

Change to:

```ts
export async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  // ...
```

No more `Authorization` header for the admin session at all — the cookie carries it automatically now, the same way it already does for the member session (if you did the member fix first, `credentials: 'include'` is likely already here; this just means the `Authorization` header logic can come out too, since nothing needs it anymore).

### 3. `src/lib/queries.ts` — update `REGISTER_USER`/`LOGIN_USER`, add `SIGN_OUT_USER` and `CURRENT_USER`

Current (marked "optional" — this is where that changes):

```ts
// --- Users (optional — see AuthContext for the recommended Supabase-driven flows) ---
export const REGISTER_USER = `
  mutation RegisterUser($name: String!, $email: String!, $password: String!) {
    registerUser(name: $name, email: $email, password: $password) {
      user { id email name }
      session { accessToken refreshToken expiresAt }
    }
  }
`;

export const LOGIN_USER = `
  mutation LoginUser($email: String!, $password: String!) {
    loginUser(email: $email, password: $password) {
      user { id email name }
      session { accessToken refreshToken expiresAt }
    }
  }
`;
```

Change to:

```ts
// --- Users ---
export const REGISTER_USER = `
  mutation RegisterUser($name: String!, $email: String!, $password: String!) {
    registerUser(name: $name, email: $email, password: $password) {
      user { id email name }
    }
  }
`;

export const LOGIN_USER = `
  mutation LoginUser($email: String!, $password: String!) {
    loginUser(email: $email, password: $password) {
      user { id email name }
    }
  }
`;

export const SIGN_OUT_USER = `
  mutation SignOutUser {
    signOutUser
  }
`;

export const CURRENT_USER = `
  query CurrentUser {
    currentUser { id email name }
  }
`;
```

### 4. `src/context/AuthContext.tsx` — rewrite

Current file relies on `supabase.auth.*` for everything. Rewrite to:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { graphqlRequest } from '../lib/graphql';
import { REGISTER_USER, LOGIN_USER, SIGN_OUT_USER, CURRENT_USER } from '../lib/queries';
import type { AppUser } from '../types';

const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL as string;
const BACKEND_ORIGIN = new URL(GRAPHQL_URL).origin;

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  signInWithGoogle: () => void;
  signInWithEmail: (email: string, password: string) => Promise<{ error: string | null }>;
  signUpWithEmail: (
    email: string,
    password: string,
    name: string,
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    graphqlRequest<{ currentUser: AppUser | null }>(CURRENT_USER)
      .then(({ currentUser }) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  function signInWithGoogle() {
    // A plain navigation, not a fetch — the whole point is this leaves the SPA
    // entirely; the backend handles the OAuth round trip and redirects back to
    // /app (or /login?error=... on failure) once the httpOnly cookie is set.
    window.location.href = `${BACKEND_ORIGIN}/auth/google`;
  }

  async function signInWithEmail(email: string, password: string) {
    try {
      const { loginUser } = await graphqlRequest<{ loginUser: { user: AppUser } }>(LOGIN_USER, {
        email,
        password,
      });
      setUser(loginUser.user);
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Invalid email or password.' };
    }
  }

  async function signUpWithEmail(email: string, password: string, name: string) {
    try {
      const { registerUser } = await graphqlRequest<{ registerUser: { user: AppUser } }>(
        REGISTER_USER,
        { email, password, name },
      );
      setUser(registerUser.user);
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Could not create account.' };
    }
  }

  async function signOut() {
    setUser(null);
    try {
      await graphqlRequest(SIGN_OUT_USER);
    } catch {
      // ignore — client-side state is already cleared either way
    }
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

**Things this touches that you'll need to chase down:**
- The context now exposes `user: AppUser | null` instead of `session: Session | null` — anything reading `session.user.id` / `session.user.email` / `session.user.user_metadata?.name` elsewhere (e.g. `TaskDetailModal.tsx`'s `actorName` — see `SECURITY_FRONTEND_ACTION_PLAN.md`) needs to read `user.id` / `user.email` / `user.name` instead. Search for `useAuth()` and `session` across the codebase — there were at least these usages found this session: `graphqlRequest` (fixed above) and `TaskDetailModal.tsx`.
- `signInWithGoogle` is no longer `async` and returns `void`, not a `Promise` — it's a synchronous navigation now. Remove any `await` on it.
- `signUpWithEmail`'s return type dropped `needsConfirmation` — the old code checked `!data.session` to know whether email confirmation was required, which doesn't map cleanly onto the new flow (the backend doesn't get a session back either, in that case — `registerUser` would return an error until confirmed, or a user with no session depending on your Supabase project's email confirmation setting). If your signup UI shows a "check your email" state based on `needsConfirmation`, that needs a different signal now — simplest is to treat any `registerUser` failure as the confirmation-required case in the error message, since Supabase's own error text usually says so; flag this specifically if your signup flow depends on that field, it may need a closer look at what `registerUser` actually returns when confirmation is pending in your project's settings.
- `isSameIdentity` in `src/lib/sessionIdentity.ts` was written specifically to prevent `Session` object churn from re-triggering effects — with `user: AppUser | null` there's no more `Session` object doing that, `AppUser` is already the flat shape that made comparisons easy. This file is very likely dead code after this change; check nothing else imports it before deleting.

### 5. `src/pages/AuthCallback.tsx` — delete it, and its route

The backend now owns the entire OAuth redirect dance and lands the browser directly on `/app` or `/login?error=...` once the cookie is set — there's no intermediate page for the frontend to run anymore. Delete the file and remove whatever route registers `/auth/callback` in your router. If anything links to `/auth/callback` (e.g. a "Sign in with Google" button using `<Link to="/auth/callback">` instead of calling `signInWithGoogle()`), point it at `signInWithGoogle()` instead.

## Verification checklist

- [x] `registerUser`/`loginUser` response bodies contain no `session` field; `Set-Cookie` sets an httpOnly Supabase session cookie
- [x] `currentUser` with no cookie and no `accessToken` arg returns `null` (not an error)
- [x] `currentUser` resolves correctly from the cookie alone, no header
- [x] A real `requireGroup`-gated query (`myGroup`) succeeds using only the cookie
- [x] `signOutUser` clears the cookie (`Set-Cookie` with `Max-Age=0`)
- [x] `currentUser` returns `null` again immediately after sign-out, using the same (now-stale) cookie
- [x] `GET /auth/google` generates a valid PKCE authorize URL pointed at this backend's own callback, and sets the code-verifier cookie
- [x] `GET /auth/google/callback` with no `code` fails safely (redirects to `/login?error=...`, doesn't throw)
- [ ] **A real Google sign-in, in a browser, end to end** — not verified by me, see "Testing limitation" above
