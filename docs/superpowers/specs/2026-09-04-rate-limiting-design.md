# Rate limiting

## Problem

Three distinct abuse scenarios are unprotected in "Continuum CRM" backend (crm-proj) today:

1. **Login brute-forcing** — `loginMember` (member JWT auth, password-based) already calls a rate limiter (`utils/rateLimit.js`'s `checkRateLimit`, committed prior to this plan, bundled into an unrelated commit and never covered by a test), but it's keyed on email alone (`loginMember:${email}`) — it stops repeated guessing against one account, but not one IP spraying password guesses across many different accounts.
2. **AI Meeting Notes cost abuse** — each recording segment triggers real Fish Audio + Anthropic API spend. The existing `aiNotesHoursPerMonth` quota is a coarse, once-per-session-start check on a monthly window; it does not stop a buggy or malicious client from bursting many requests in a short window before that check would ever catch it. No rate limiter exists on this path at all.
3. **General API flooding** — no protection against a client or bot hitting the GraphQL API very fast, regardless of which operation it's calling.

## Goals

- Stop all three abuse scenarios above, each with a limiter keyed on the dimension that actually matters for that scenario (IP for general flooding; email+IP for login; groupId for AI-notes cost, since that's the actual cost-bearing unit — not the caller's IP).
- Fit the existing single-instance, no-Redis Hostinger deployment — no new infrastructure dependency.
- Match the existing error-handling conventions in this codebase (GraphQLError with an `extensions.code`, same shape as `AI_NOTES_QUOTA_EXCEEDED` / `TRIAL_FEATURE_LOCKED`).

## Non-goals

- Rate-limiting the Paddle webhook route or the Google OAuth redirect routes — different traffic shape (server-to-server signed webhook; infrequent user-initiated browser redirects), each with its own existing safeguards. Blanket-limiting them risks false-positives on legitimate Paddle webhook delivery.
- Surviving process restarts — an in-memory counter reset on deploy/crash-restart is acceptable; this is abuse mitigation, not a security boundary that must be durable.
- Distributed/multi-instance correctness (e.g. via Redis) — out of scope while the app runs as a single Node process. Revisit if that changes.
- Rate-limiting every other mutation/query in the schema — only the three scenarios above are in scope; broad IP-based flooding protection already covers everything else at a coarse level.

## Architecture

**`config/rateLimiter.js`** — an `express-rate-limit` instance, mounted only in front of the GraphQL endpoint in `server.js` (inserted into the existing `app.use(express.json(...), expressMiddleware(...))` chain, as the first middleware there — before `express.json`, so an over-limit request is rejected before any body parsing). Not applied globally to the whole Express app: `/auth/google`, `/auth/google/callback`, and `/webhooks/paddle` are left unlimited, per the Non-goals above. Default: **300 requests / 5 minutes per IP** (`windowMs: 5 * 60 * 1000, max: 300`), using `req.ip` as the key (the library's default). On exceeding, `express-rate-limit`'s default behavior applies: `429` with standard `RateLimit-*` headers and a plain JSON body — this happens entirely at the Express layer, before Apollo/GraphQL ever sees the request, so no GraphQLError is involved here.

**`utils/rateLimit.js`** (already exists — reused, not rewritten) — a sliding-window limiter keyed by an arbitrary string:
```js
export const checkRateLimit = (key, { max = 5, windowMs = 15 * 60 * 1000 } = {}) => {
  // throws a GraphQLError('Too many attempts. Please try again later.',
  // { extensions: { code: 'RATE_LIMITED' } }) if this key has been called
  // `max` or more times within the trailing `windowMs`; otherwise records
  // this call (push a timestamp) and returns.
}
```
It already throws the exact `GraphQLError`/`RATE_LIMITED` shape this plan wants, so call sites need no catch/rethrow — just call it and let the error propagate. One small, backward-compatible extension: add an optional `message` parameter (`{ max, windowMs, message = 'Too many attempts. Please try again later.' }`) so new call sites can use clearer, context-specific text while the existing `loginMember` call site (which doesn't pass one) keeps its current message unchanged.

**Call sites:**
- `models/membersFunction.js`'s `loginMember` — existing call `checkRateLimit(`loginMember:${email.toLowerCase()}`)` stays as-is (still stops repeated guessing against one account). Add a second call, keyed on IP alone, to close the spray-attack gap: `checkRateLimit(`loginMember-ip:${ip}`, { max: 20, windowMs: 15 * 60 * 1000 })` — looser than the per-email limit (20 vs 5) since one IP can legitimately represent many real users behind NAT/an office network, but still bounds how many total guesses one IP can make across all accounts in the window. Requires threading `ip` into `loginMember(email, password, ip)`'s signature; the resolver passes `context.req.ip`.
- `resolvers/meetingRecordingResolvers.js`'s `requestMeetingRecordingUploadUrl`: after `requireGroup(context)` resolves `groupId` (and before the existing trial-gate/quota logic — cheapest check first), call `checkRateLimit(`ai-notes-upload:${groupId}`, { max: 10, windowMs: 60 * 1000, message: 'Too many recording requests. Slow down and try again shortly.' })`.
- `resolvers/meetingRecordingResolvers.js`'s `finishMeetingRecording`: same pattern, `checkRateLimit(`ai-notes-finish:${groupId}`, { max: 5, windowMs: 60 * 1000, message: 'Too many recording requests. Slow down and try again shortly.' })` — tighter, since each call here triggers real per-segment Fish/Anthropic spend, not just an R2 presigned-URL issuance.

**`server.js` change:** import `rateLimiter` from `config/rateLimiter.js`, insert it as the first argument to the existing `app.use(express.json({ limit: '400kb' }), expressMiddleware(server, { ... }))` call (i.e. `app.use(rateLimiter, express.json({ limit: '400kb' }), expressMiddleware(...))`). Also add `app.set('trust proxy', 1)` — Hostinger's Node.js hosting sits behind its own edge/proxy layer (confirmed by the `platform: hostinger` / `hcdn` response headers seen in production traffic during earlier debugging this session), so without this, `req.ip` resolves to the proxy's IP for every request, making the login limiter key identically for all callers instead of distinguishing them. `trust proxy: 1` tells Express to trust exactly one hop of `X-Forwarded-For` (the immediate proxy), which is the correct setting for a single edge/CDN layer in front of the app — the standard configuration for this exact topology, not something that needs live experimentation. Set it unconditionally as part of this change; no separate verification step needed before merging.

## Error handling

| Layer | Trigger | Response |
|---|---|---|
| Global (Express, `config/rateLimiter.js`) | >300 req / 5 min from one IP to the GraphQL endpoint | HTTP `429`, `express-rate-limit` default JSON body + `RateLimit-*` headers, before body parsing |
| Login, per-account (`loginMember:${email}`, existing) | >5 attempts / 15 min for one email | `GraphQLError`, code `RATE_LIMITED`, `'Too many attempts. Please try again later.'` |
| Login, per-IP (`loginMember-ip:${ip}`, new) | >20 attempts / 15 min for one IP, across any accounts | `GraphQLError`, code `RATE_LIMITED`, `'Too many attempts. Please try again later.'` |
| AI-notes upload (`requestMeetingRecordingUploadUrl`) | >10 req / 1 min for one `groupId` | `GraphQLError`, code `RATE_LIMITED`, `'Too many recording requests. Slow down and try again shortly.'` |
| AI-notes finish (`finishMeetingRecording`) | >5 req / 1 min for one `groupId` | `GraphQLError`, code `RATE_LIMITED`, `'Too many recording requests. Slow down and try again shortly.'` |

## Testing

- `utils/rateLimit.test.js` (new — this file has no coverage today): allows calls under `max`; throws at/over `max` with the default message; a custom `message` option is used when provided; resets and allows again after `windowMs` elapses (fake timers via `vi.useFakeTimers()`); two different keys never interfere with each other's counts.
- `models/membersFunction.test.js` (new file — confirmed no test file exists for this module today): a test confirms `loginMember` rejects with `RATE_LIMITED` after 5 calls for one email within the window (existing behavior, now covered for the first time), and a separate test confirms it also rejects after 20 calls from one IP across *different* emails (the new behavior), while confirming a *different* IP with its own few attempts is unaffected. Must confirm the limiter fires based on call count regardless of whether the underlying password check would have succeeded or failed (rate limiting applies to attempts, not just failures — matches the "brute-force" threat model, where an attacker doesn't know in advance which guess succeeds).
- `resolvers/meetingRecordingResolvers.test.js`: new tests confirm `requestMeetingRecordingUploadUrl` and `finishMeetingRecording` each reject with `RATE_LIMITED` after their respective `max` is hit for one `groupId`, and that a *different* `groupId` is unaffected (proves the keying is per-group, not global).
- No test for the global Express-layer limiter beyond confirming `server.js` wires it in correctly (no existing test file covers `server.js`'s middleware chain directly — matches this codebase's convention of not testing wiring, only logic).
