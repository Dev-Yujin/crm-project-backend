# Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop three unprotected abuse scenarios in "Continuum CRM" backend (crm-proj): login credential-stuffing across accounts, AI Meeting Notes cost abuse (real Fish Audio/Anthropic spend), and general GraphQL API flooding.

**Architecture:** Reuse and extend the existing (untested, email-only) `utils/rateLimit.js` sliding-window limiter for the two resolver-level checks (login-by-IP, AI-notes-by-groupId), and add a new `express-rate-limit`-based global IP limiter in front of the GraphQL endpoint for broad flooding protection. No new infrastructure — everything is in-process, in-memory, matching the existing single-instance Hostinger deployment.

**Tech Stack:** Node.js/Express/Apollo GraphQL (existing), `express-rate-limit` (new dependency, small and widely used), Vitest (existing test framework).

## Global Constraints

- Rate-limit error responses from `utils/rateLimit.js`'s `checkRateLimit` use `GraphQLError` with `extensions: { code: 'RATE_LIMITED' }` — this already exists and must not change shape.
- The existing `loginMember:${email.toLowerCase()}` call and its `max: 5, windowMs: 15 * 60 * 1000` defaults must be preserved exactly — do not change its behavior, only add alongside it.
- New IP-based login limit: `max: 20, windowMs: 15 * 60 * 1000`, key `loginMember-ip:${ip}`.
- AI-notes upload limit: `max: 10, windowMs: 60 * 1000`, key `ai-notes-upload:${groupId}`, message `'Too many recording requests. Slow down and try again shortly.'`.
- AI-notes finish limit: `max: 5, windowMs: 60 * 1000`, key `ai-notes-finish:${groupId}`, message `'Too many recording requests. Slow down and try again shortly.'`.
- Global Express-layer limit: `max: 300, windowMs: 5 * 60 * 1000` per IP, mounted only in front of the GraphQL endpoint — never on `/auth/google`, `/auth/google/callback`, or `/webhooks/paddle`.
- `app.set('trust proxy', 1)` must be set in `server.js` — Hostinger's Node.js hosting sits behind one edge/proxy hop, so without this `req.ip` resolves to the proxy's IP for every request, making every IP-keyed check useless (everyone shares one bucket).
- No new test file may weaken or delete the existing (currently absent, being added by this plan) coverage of `loginMember:${email}` behavior.

---

### Task 1: Extend `utils/rateLimit.js` with a custom message option, and add its first test file

**Files:**
- Modify: `utils/rateLimit.js`
- Test: `utils/rateLimit.test.js` (new — this file has no coverage today)

**Interfaces:**
- Produces: `checkRateLimit(key: string, { max = 5, windowMs = 15 * 60 * 1000, message = 'Too many attempts. Please try again later.' } = {})` — throws `GraphQLError(message, { extensions: { code: 'RATE_LIMITED' } })` when `key` has been called `max` or more times within the trailing `windowMs`; otherwise records the call and returns `undefined`. Backward compatible: any existing call site that only passes `{ max, windowMs }` (or nothing) behaves identically to before this task.

- [ ] **Step 1: Write the failing tests**

Create `utils/rateLimit.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkRateLimit } from './rateLimit.js';

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls under the limit', () => {
    const key = `test-under-${Math.random()}`;
    for (let i = 0; i < 4; i++) {
      expect(() => checkRateLimit(key, { max: 5, windowMs: 1000 })).not.toThrow();
    }
  });

  it('throws with the default message once max is reached', () => {
    const key = `test-default-msg-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, { max: 5, windowMs: 1000 });
    }
    expect(() => checkRateLimit(key, { max: 5, windowMs: 1000 })).toThrow(
      'Too many attempts. Please try again later.',
    );
  });

  it('throws with a custom message when provided', () => {
    const key = `test-custom-msg-${Math.random()}`;
    for (let i = 0; i < 2; i++) {
      checkRateLimit(key, { max: 2, windowMs: 1000, message: 'Slow down.' });
    }
    expect(() => checkRateLimit(key, { max: 2, windowMs: 1000, message: 'Slow down.' })).toThrow(
      'Slow down.',
    );
  });

  it('sets extensions.code to RATE_LIMITED', () => {
    const key = `test-code-${Math.random()}`;
    checkRateLimit(key, { max: 1, windowMs: 1000 });
    try {
      checkRateLimit(key, { max: 1, windowMs: 1000 });
      throw new Error('expected checkRateLimit to throw');
    } catch (err) {
      expect(err.extensions.code).toBe('RATE_LIMITED');
    }
  });

  it('resets and allows again after windowMs elapses', () => {
    const key = `test-reset-${Math.random()}`;
    checkRateLimit(key, { max: 1, windowMs: 1000 });
    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).toThrow();

    vi.advanceTimersByTime(1001);

    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).not.toThrow();
  });

  it('does not let two different keys interfere with each other', () => {
    const keyA = `test-key-a-${Math.random()}`;
    const keyB = `test-key-b-${Math.random()}`;
    checkRateLimit(keyA, { max: 1, windowMs: 1000 });
    expect(() => checkRateLimit(keyA, { max: 1, windowMs: 1000 })).toThrow();
    expect(() => checkRateLimit(keyB, { max: 1, windowMs: 1000 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify which fail**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run utils/rateLimit.test.js`
Expected: the `'throws with a custom message when provided'` test FAILS (current implementation ignores a `message` option and always throws the hardcoded default text). All other tests should already PASS against the existing implementation — this confirms the existing sliding-window logic is sound and only the `message` option is missing.

- [ ] **Step 3: Add the `message` option**

Read the current file first (`utils/rateLimit.js`) — it currently reads:
```js
import { GraphQLError } from 'graphql';

const attemptsByKey = new Map();

//In-memory sliding-window limiter. Single-process only — fine for this deployment, but
//won't hold across multiple server instances/restarts. Good enough as a first mitigation
//against credential stuffing on loginMember.
export const checkRateLimit = (key, { max = 5, windowMs = 15 * 60 * 1000 } = {}) => {
    const now = Date.now();
    const attempts = (attemptsByKey.get(key) ?? []).filter((ts) => now - ts < windowMs);

    if (attempts.length >= max) {
        throw new GraphQLError('Too many attempts. Please try again later.', {
            extensions: { code: 'RATE_LIMITED' },
        });
    }

    attempts.push(now);
    attemptsByKey.set(key, attempts);
};
```

Change the function signature and throw line to:
```js
export const checkRateLimit = (
    key,
    { max = 5, windowMs = 15 * 60 * 1000, message = 'Too many attempts. Please try again later.' } = {},
) => {
    const now = Date.now();
    const attempts = (attemptsByKey.get(key) ?? []).filter((ts) => now - ts < windowMs);

    if (attempts.length >= max) {
        throw new GraphQLError(message, {
            extensions: { code: 'RATE_LIMITED' },
        });
    }

    attempts.push(now);
    attemptsByKey.set(key, attempts);
};
```
(Only the function signature's destructured parameters and the `throw new GraphQLError(message, ...)` line change — everything else, including the module comment, stays as-is.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run utils/rateLimit.test.js`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Run the full backend suite to confirm no regression**

Run: `cd /Users/eugenelinsangan/crm-proj && npm test`
Expected: PASS — every test file (this change is additive and backward-compatible, so nothing else should be affected).

- [ ] **Step 6: Commit**

```bash
cd /Users/eugenelinsangan/crm-proj
git add utils/rateLimit.js utils/rateLimit.test.js
git commit -m "test: add coverage for the existing rate limiter, add a message option"
```

---

### Task 2: Add an IP-based login rate limit alongside the existing per-email one

**Files:**
- Modify: `models/membersFunction.js`
- Modify: `resolvers/memberResolvers.js`
- Modify: `server.js`
- Test: `models/membersFunction.test.js` (new — no test file exists for this module today)

**Interfaces:**
- Consumes: `checkRateLimit` from Task 1 (`utils/rateLimit.js`), unchanged signature plus the new optional `message`.
- Produces: `loginMember(email, password, ip)` — the exported model function gains a third, required parameter. Every caller must be updated in this same task (there is exactly one: `resolvers/memberResolvers.js`'s `loginMember` mutation resolver).

- [ ] **Step 1: Write the failing tests**

Create `models/membersFunction.test.js`. Read `models/membersFunction.js` first to confirm its exact imports (`pool` from `../config/supabase.js`, `hashPassword`/`comparePasswords`/`generateMemberToken`/`verifyMemberToken` from `../utils/authUser.js`) — mock both, matching the mocking style already used elsewhere in this codebase (e.g. `resolvers/meetingRecordingResolvers.test.js`'s `vi.mock` blocks):

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));
vi.mock('../utils/authUser.js', () => ({
  hashPassword: vi.fn(),
  comparePasswords: vi.fn(async () => false),
  generateMemberToken: vi.fn(() => 'fake-token'),
  verifyMemberToken: vi.fn(),
}));

const { pool } = await import('../config/supabase.js');
const { comparePasswords } = await import('../utils/authUser.js');
const { loginMember } = await import('./membersFunction.js');

describe('loginMember rate limiting', () => {
  beforeEach(() => {
    pool.query.mockReset();
    comparePasswords.mockReset();
    comparePasswords.mockResolvedValue(false);
    // Every attempt finds no matching row, so the function fails fast on
    // "Member not found" after the rate-limit check — that's fine, the
    // rate limiter runs before the DB query either way.
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('rejects the 6th attempt for the same email within the window, regardless of IP', async () => {
    const email = `rl-email-test-${Math.random()}@example.com`;
    for (let i = 0; i < 5; i++) {
      await expect(loginMember(email, 'wrong', `1.2.3.${i}`)).rejects.toThrow();
    }
    await expect(loginMember(email, 'wrong', '9.9.9.9')).rejects.toThrow(/too many attempts/i);
  });

  it('rejects the 21st attempt from the same IP within the window, across different emails', async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 1000)}`;
    for (let i = 0; i < 20; i++) {
      await expect(loginMember(`rl-ip-test-${i}@example.com`, 'wrong', ip)).rejects.toThrow();
    }
    await expect(loginMember('rl-ip-test-final@example.com', 'wrong', ip)).rejects.toThrow(
      /too many attempts/i,
    );
  });

  it('does not rate-limit a different IP making its own first attempt', async () => {
    await expect(
      loginMember('rl-unrelated@example.com', 'wrong', `203.0.113.${Math.floor(Math.random() * 1000)}`),
    ).rejects.toThrow(/member not found/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify which fail**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run models/membersFunction.test.js`
Expected: the first test (`'rejects the 6th attempt for the same email...'`) PASSES already (existing behavior). The second test (`'rejects the 21st attempt from the same IP...'`) FAILS — `loginMember` doesn't accept or check an `ip` parameter yet, so 20 different emails from the "same IP" never get linked together and the 21st call fails with "Member not found" instead of a rate-limit error.

- [ ] **Step 3: Add the IP-based check to `loginMember`**

Read `models/membersFunction.js`'s current `loginMember` — it currently reads:
```js
export const loginMember = async (email, password) => {
    checkRateLimit(`loginMember:${email.toLowerCase()}`);

    try {
```

Change to:
```js
export const loginMember = async (email, password, ip) => {
    checkRateLimit(`loginMember:${email.toLowerCase()}`);
    checkRateLimit(`loginMember-ip:${ip}`, { max: 20, windowMs: 15 * 60 * 1000 });

    try {
```

- [ ] **Step 4: Update the one call site**

Read `resolvers/memberResolvers.js`'s `loginMember` mutation — it currently reads:
```js
        loginMember: async (_, { email, password }, context) => {
            const { member, token } = await loginMember(email, password);
```

Change to:
```js
        loginMember: async (_, { email, password }, context) => {
            const { member, token } = await loginMember(email, password, context.req.ip);
```

- [ ] **Step 5: Add `trust proxy` in `server.js`**

Hostinger's Node.js hosting sits behind one edge/proxy hop — without telling Express to trust it, `req.ip` resolves to the proxy's own IP for every request, making the IP-keyed check above useless (every caller shares one bucket). In `server.js`, find:
```js
const app = express();
const httpServer = http.createServer(app);
```
Change to:
```js
const app = express();
app.set('trust proxy', 1);
const httpServer = http.createServer(app);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run models/membersFunction.test.js`
Expected: PASS — all 3 tests.

- [ ] **Step 7: Run the full backend suite to confirm no regression**

Run: `cd /Users/eugenelinsangan/crm-proj && npm test`
Expected: PASS — every test file. `resolvers/memberResolvers.js:55` is the only real call site of `loginMember(...)` in this codebase (confirmed via `grep -rn "loginMember(" --include="*.js"`, excluding the GraphQL schema string in `typedefs/memberTypeDefs.js` which is unrelated to this JS function's signature) — it was already updated in Step 4, so no other caller needs changing.

- [ ] **Step 8: Commit**

```bash
cd /Users/eugenelinsangan/crm-proj
git add models/membersFunction.js models/membersFunction.test.js resolvers/memberResolvers.js server.js
git commit -m "feat: rate-limit login attempts by IP in addition to by email"
```

---

### Task 3: Rate-limit the AI Meeting Notes upload and finish mutations by group

**Files:**
- Modify: `resolvers/meetingRecordingResolvers.js`
- Test: `resolvers/meetingRecordingResolvers.test.js`

**Interfaces:**
- Consumes: `checkRateLimit` from Task 1 (`utils/rateLimit.js`).

- [ ] **Step 1: Write the failing tests**

Add this import near the top of `resolvers/meetingRecordingResolvers.test.js`, alongside its other `vi.mock` blocks — find:
```js
const { createUploadUrl } = await import('../config/r2.js');
```
Add a new line right after it:
```js
const { checkRateLimit } = await import('../utils/rateLimit.js');
```
`checkRateLimit` does NOT need a `vi.mock('../utils/rateLimit.js', ...)` block — this test exercises the real sliding-window logic directly (matching Task 1's own real, non-mocked test style), so a genuine 11th call in a 1-minute window really does throw, proving the wiring end-to-end rather than a mocked stand-in.

Add these tests inside the existing `describe('requestMeetingRecordingUploadUrl', ...)` block:
```js
  it('rejects the 11th upload-URL request for one group within a minute', async () => {
    const groupId = `rl-upload-test-${Math.random()}`;
    const localContext = { user: { id: 'u1' }, groupId, member: null };
    for (let i = 0; i < 10; i++) {
      await meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: `s-${i}`, segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        localContext,
      );
    }
    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's-11', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        localContext,
      ),
    ).rejects.toThrow(/too many recording requests/i);
  });

  it('does not rate-limit a different group', async () => {
    const groupId = `rl-upload-other-${Math.random()}`;
    const localContext = { user: { id: 'u1' }, groupId, member: null };
    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's-solo', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        localContext,
      ),
    ).resolves.toBeDefined();
  });
```

Note: `getOrCreateSession`'s module-level mock (already in this file) returns `{ ..., created: true }` for any `sessionId`, and `getOrCreateBilling`'s module-level mock returns non-trialing limits — both defaults apply here with no extra setup, so each of the 10 calls above succeeds normally up to the point the 11th is rate-limited.

Add this test inside the existing `describe('finishMeetingRecording', ...)` block:
```js
  it('rejects the 6th finish request for one group within a minute', async () => {
    const groupId = `rl-finish-test-${Math.random()}`;
    const localContext = { user: { id: 'u1' }, groupId, member: null };
    getSessionWithSegments.mockResolvedValue({
      session: { sessionId: 's1', groupId, status: 'recording' },
      segments: [],
    });
    for (let i = 0; i < 5; i++) {
      // transcriptParts stays empty (no segments), so each call fails with
      // TRANSCRIPTION_FAILED after the rate-limit check passes — that's fine,
      // the rate limiter runs before any of that logic.
      await expect(
        meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, localContext),
      ).rejects.toThrow();
    }
    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, localContext),
    ).rejects.toThrow(/too many recording requests/i);
  });
```

- [ ] **Step 2: Run the tests to verify which fail**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run resolvers/meetingRecordingResolvers.test.js`
Expected: the three new tests FAIL (no rate limiting exists on these two mutations yet — the 11th/6th calls succeed or fail for unrelated reasons instead of a `RATE_LIMITED` error).

- [ ] **Step 3: Add the rate-limit checks**

In `resolvers/meetingRecordingResolvers.js`, add the import. Find:
```js
import { transcribeSegment } from '../services/fishTranscription.js';
import { formatMeetingTranscript } from '../services/meetingNotesFormatter.js';
```
Change to:
```js
import { transcribeSegment } from '../services/fishTranscription.js';
import { formatMeetingTranscript } from '../services/meetingNotesFormatter.js';
import { checkRateLimit } from '../utils/rateLimit.js';
```

In `requestMeetingRecordingUploadUrl`, find:
```js
      const groupId = requireGroup(context);
      const uploadedBy = `admin:${context.user.id}`;

      validateSegmentContentType(contentType);
      validateSegmentSize(sizeBytes);

      const billing = await getOrCreateBilling(groupId);
      requireNotTrialing(billing);
```
Change to:
```js
      const groupId = requireGroup(context);
      const uploadedBy = `admin:${context.user.id}`;

      checkRateLimit(`ai-notes-upload:${groupId}`, {
        max: 10,
        windowMs: 60 * 1000,
        message: 'Too many recording requests. Slow down and try again shortly.',
      });

      validateSegmentContentType(contentType);
      validateSegmentSize(sizeBytes);

      const billing = await getOrCreateBilling(groupId);
      requireNotTrialing(billing);
```

In `finishMeetingRecording`, find:
```js
    finishMeetingRecording: async (_, { sessionId }, context) => {
      const groupId = requireGroup(context);

      const billing = await getOrCreateBilling(groupId);
      requireNotTrialing(billing);
```
Change to:
```js
    finishMeetingRecording: async (_, { sessionId }, context) => {
      const groupId = requireGroup(context);

      checkRateLimit(`ai-notes-finish:${groupId}`, {
        max: 5,
        windowMs: 60 * 1000,
        message: 'Too many recording requests. Slow down and try again shortly.',
      });

      const billing = await getOrCreateBilling(groupId);
      requireNotTrialing(billing);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run resolvers/meetingRecordingResolvers.test.js`
Expected: PASS — all tests in the file, including the three new ones and every pre-existing test (each pre-existing test uses its own fresh `sessionId`/`groupId` value like `'g1'`, well under any of the new limits within the test run, so none of them trip the new checks).

- [ ] **Step 5: Run the full backend suite to confirm no regression**

Run: `cd /Users/eugenelinsangan/crm-proj && npm test`
Expected: PASS — every test file.

- [ ] **Step 6: Commit**

```bash
cd /Users/eugenelinsangan/crm-proj
git add resolvers/meetingRecordingResolvers.js resolvers/meetingRecordingResolvers.test.js
git commit -m "feat: rate-limit AI Meeting Notes upload/finish mutations per group"
```

---

### Task 4: Add a global IP-based rate limiter in front of the GraphQL endpoint

**Files:**
- Create: `config/rateLimiter.js`
- Modify: `server.js`
- Modify: `package.json` (new dependency)

**Interfaces:**
- Produces: `rateLimiter` (default export from `config/rateLimiter.js`) — an Express middleware function.

- [ ] **Step 1: Install the dependency**

```bash
cd /Users/eugenelinsangan/crm-proj && npm install express-rate-limit@^7
```

- [ ] **Step 2: Create `config/rateLimiter.js`**

```js
import rateLimit from 'express-rate-limit';

// Broad, coarse protection against a client or bot hammering the GraphQL endpoint —
// generous enough for a busy real admin session, tight enough to blunt real flooding.
// Only mounted in front of the GraphQL POST route in server.js, never on the OAuth
// redirect routes or the Paddle webhook — those have their own traffic shapes and
// existing safeguards (a signed webhook shouldn't ever be blocked by a shared-IP limit).
const rateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

export default rateLimiter;
```

There is no meaningful unit test for this file beyond "does it export a function" — `express-rate-limit` is itself a well-tested library, and this file's only job is configuring it with the constants above (a wiring concern, not logic this codebase's convention tests — matching how `server.js` itself has no test file).

- [ ] **Step 3: Wire it into `server.js`**

Find:
```js
import billingLockPlugin from './utils/billingLockPlugin.js';
```
Add a new import line right after it:
```js
import billingLockPlugin from './utils/billingLockPlugin.js';
import rateLimiter from './config/rateLimiter.js';
```

Find:
```js
  app.use(
    express.json({ limit: '400kb' }),
    expressMiddleware(server, {
      context: async ({ req, res }) => ({ ...(await resolveContext(req, res)), res, req }),
    })
  );
```
Change to:
```js
  app.use(
    rateLimiter,
    express.json({ limit: '400kb' }),
    expressMiddleware(server, {
      context: async ({ req, res }) => ({ ...(await resolveContext(req, res)), res, req }),
    })
  );
```

(`trust proxy` was already set in Task 2, Step 5 — no change needed here; `express-rate-limit` reads `req.ip`, which now correctly reflects the real client IP through Hostinger's one proxy hop.)

- [ ] **Step 4: Manually verify the server still starts and responds normally**

Run: `cd /Users/eugenelinsangan/crm-proj && timeout 5 node server.js || true` — or, if `timeout` isn't available on this platform, start it with `npm run dev` in the background, then in a separate terminal:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/
```
Expected: `400` (Apollo's normal response to a bare GET with no query — the existing, healthy signature for this server, confirmed earlier in this project's history), NOT `429` or a connection error. Stop the server afterward.

- [ ] **Step 5: Run the full backend suite to confirm no regression**

Run: `cd /Users/eugenelinsangan/crm-proj && npm test`
Expected: PASS — every test file.

- [ ] **Step 6: Commit**

```bash
cd /Users/eugenelinsangan/crm-proj
git add config/rateLimiter.js server.js package.json package-lock.json
git commit -m "feat: add a global rate limiter in front of the GraphQL endpoint"
```

---
