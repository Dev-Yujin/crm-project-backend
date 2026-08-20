# Frontend Changes Required — Compiled Summary

One consolidated checklist covering every frontend change from this security pass, pulled together from [SECURITY_FRONTEND_ACTION_PLAN.md](./SECURITY_FRONTEND_ACTION_PLAN.md) (member auth) and [ADMIN_SESSION_SECURITY_INTEGRATION.md](./ADMIN_SESSION_SECURITY_INTEGRATION.md) (admin/user auth). Those two docs have the full reasoning and exact code diffs — this is the "what needs touching, in what order" view.

**Nothing here is optional.** Both fixes are already deployed backend-side. Until the frontend changes ship, real members and real admins cannot log in or do anything auth-gated — this isn't a soft rollout, it's already live.

## Do this first — the one thing only you can do

**Supabase Dashboard → Authentication → URL Configuration → Redirect URLs** — add:
```
http://localhost:4000/auth/google/callback
https://crm-backend.microdramamarketers.com/auth/google/callback
```
Without this, Google sign-in fails immediately after consent, in every environment. No code change fixes this — it's a project setting only you can reach.

## File-by-file punch list

| File | What changes | Why | Details |
|---|---|---|---|
| `src/lib/graphql.ts` | Add `credentials: 'include'`; remove the `supabase.auth.getSession()` / `Authorization` header logic entirely | Cookies now carry both admin and member sessions — nothing needs a bearer header anymore | Both docs, §1 |
| `src/context/MemberSessionContext.tsx` | Full rewrite — drop `localStorage` (`crm-member-token`), use cookie-based `currentMember`/`loginMember`, call new `logoutMember` mutation | This was the literal vulnerability the original report was about | `SECURITY_FRONTEND_ACTION_PLAN.md` §2 |
| `src/context/AuthContext.tsx` | Full rewrite — drop all `supabase.auth.*` calls, use `currentUser`/`loginUser`/`registerUser`/`signOutUser` GraphQL ops, `signInWithGoogle()` becomes a plain redirect to `GET /auth/google` | Same class of fix, for the admin session | `ADMIN_SESSION_SECURITY_INTEGRATION.md` §4 |
| `src/lib/supabase.ts` | **Delete** | No longer needed anywhere — verified no other consumer exists | `ADMIN_SESSION_SECURITY_INTEGRATION.md` §1 |
| `src/pages/AuthCallback.tsx` | **Delete**, and remove its `/auth/callback` route | Backend now handles the whole OAuth redirect and lands directly on `/app` or `/login` | `ADMIN_SESSION_SECURITY_INTEGRATION.md` §5 |
| `src/lib/queries.ts` | `LOGIN_MEMBER` — drop `token` from selection; `CURRENT_MEMBER` — drop `$token` arg; add `LOGOUT_MEMBER`. `REGISTER_USER`/`LOGIN_USER` — drop `session {...}` from selection; add `SIGN_OUT_USER`, `CURRENT_USER` | Match the new cookie-only response shapes | Both docs |
| `src/types/index.ts` | `MemberAuthPayload` — remove `token: string` field (already done — this file changed externally mid-session) | Matches backend schema | `MEMBER_SECURITY_INTEGRATION.md` |
| `src/components/member/MemberProfileView.tsx` | After a password-change save, call `logout()` instead of showing in-place success | Changing your own password now invalidates your own session cookie too | `SECURITY_FRONTEND_ACTION_PLAN.md` §5 |
| Anywhere reading `session.user.*` from `useAuth()` (e.g. `TaskDetailModal.tsx`'s `actorName`) | Read `user.*` instead — `useAuth()` now exposes `user: AppUser \| null`, not `session: Session \| null` | Shape changed along with the rewrite | `ADMIN_SESSION_SECURITY_INTEGRATION.md` §4 |
| `src/lib/sessionIdentity.ts` (`isSameIdentity`) | Very likely dead code now — check for other imports, then delete | Existed only to smooth over `Session` object churn from `supabase-js`, which no longer exists in the frontend | `ADMIN_SESSION_SECURITY_INTEGRATION.md` §4 |
| `.env` | Remove `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` once `lib/supabase.ts` is gone | No longer read anywhere | `ADMIN_SESSION_SECURITY_INTEGRATION.md` §1 |

**Not required, but confirm while you're in there — already correct as-is, no changes needed:**
- `EDIT_MEMBER_PROFILE` and `SUBMIT_TASK` operation strings and their call sites in `Members.tsx`, `TaskDetailModal.tsx`, `SubmitOnStatusModal.tsx`, `MemberTaskModal.tsx` — the backend turned out to accept either an admin session or a member session on these two, so the existing call shapes already work. See `SECURITY_FRONTEND_ACTION_PLAN.md` → "What didn't change."

## Suggested order

1. Supabase dashboard redirect URL (above) — takes two minutes, unblocks testing everything else.
2. `graphql.ts` (both fixes depend on this one change).
3. `queries.ts` + `types/index.ts`.
4. `MemberSessionContext.tsx` and `AuthContext.tsx` (can be done in parallel, independent of each other).
5. Delete `supabase.ts` and `AuthCallback.tsx`, fix whatever that breaks the build (should just be the `useAuth()` shape change in `TaskDetailModal.tsx` and the dead `sessionIdentity.ts`).
6. `MemberProfileView.tsx` password-change fix.
7. Test both login flows for real, in a browser — Google sign-in specifically, since that's the one step nobody has verified end to end yet.

## After it ships

Confirm on the **production backend** specifically (separate from anything frontend):
- `NODE_ENV=production` is set (cookies need this for the `Secure` flag)
- `FRONTEND_ORIGIN` includes the real production frontend origin
- `PUBLIC_BACKEND_URL` is set to the backend's real public URL (used to build the Google OAuth callback)
