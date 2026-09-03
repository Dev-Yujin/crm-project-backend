# Trial-Tier Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trial-status groups (`group_billing.status === 'trialing'`) cannot use AI Meeting Notes at all, and are capped at 3GB storage instead of Starter's 10GB — enforced in both the backend (source of truth) and the frontend (clear UX), with everything else about trial (seat limits, other features) unchanged.

**Architecture:** A `TRIAL_LIMITS` override in `config/plans.js` makes `planLimitsResponse` return 3GB/0-hours for trial groups instead of falling back to Starter's real limits; the storage cap then applies for free through the existing `checkStorageQuota` mechanism. AI Meeting Notes gets a new explicit `requireNotTrialing` gate in its two entry-point mutations, since the existing hours-quota system's messaging is about usage, not eligibility. The frontend mirrors the same `billing.status` check before ever requesting microphone access, and shows an upgrade link on the resulting message.

**Tech Stack:** Node.js/Express/Apollo GraphQL (backend, crm-proj), React/TypeScript (frontend, crm-frontend), Vitest (backend tests only — no frontend test suite exists in this repo).

## Global Constraints

- `group_billing.status === 'trialing'` is the exact string to gate on (verbatim from the schema/existing code — see `models/billing.js`).
- Trial-tier storage cap is exactly 3GB; AI-notes hours are exactly 0 (full block, not a reduced quota).
- Everything else about a trial group's limits (admin/member seat counts, tier/name/priceMonthlyUsd shape) stays at Starter's values — do not touch those fields.
- Backend rejection uses GraphQL error code `TRIAL_FEATURE_LOCKED` and message `'AI Meeting Notes requires a paid plan.'` — use this exact string in both the backend error and the frontend's own pre-emptive message, so the two stay consistent regardless of which one a user actually sees.
- Frontend UX is "hard block with upgrade prompt": the Record button and panel stay visible and clickable for trial accounts — do not hide or disable them. The block happens on click, before `getUserMedia` is ever called.
- No new dependencies. No changes to rate limiting or security scanning — those are tracked separately, outside this plan.

---

### Task 1: Backend — trial-tier limits in `config/plans.js` and `models/billing.js`

**Files:**
- Modify: `config/plans.js`
- Modify: `models/billing.js:12`
- Modify: `resolvers/billingResolvers.js:18`
- Test: `config/plans.test.js`
- Test: `models/billing.test.js`

**Interfaces:**
- Produces: `planLimitsResponse(planKey, status)` — `status` is a new optional second parameter. When `status === 'trialing'`, the returned object's `storageGb` is `3` and `aiNotesHoursPerMonth` is `0`; every other field is unchanged from today's Starter-fallback behavior. Existing callers that only pass one argument keep today's exact behavior (falls back to Starter's real limits).

- [ ] **Step 1: Write the failing tests in `config/plans.test.js`**

Add these two tests inside the existing `describe('planLimitsResponse', ...)` block:

```js
  it('returns trial-tier limits (3GB storage, 0 AI-notes hours) when status is trialing', () => {
    const result = planLimitsResponse(null, 'trialing');
    expect(result.storageGb).toBe(3);
    expect(result.aiNotesHoursPerMonth).toBe(0);
    // Everything else still reads as Starter-shaped.
    expect(result.tier).toBe('STARTER');
    expect(result.adminLimit).toBe(1);
    expect(result.memberLimit).toBe(10);
  });

  it('does not apply trial limits when status is omitted or not trialing', () => {
    expect(planLimitsResponse(null).storageGb).toBe(10);
    expect(planLimitsResponse(null).aiNotesHoursPerMonth).toBe(5);
    expect(planLimitsResponse(null, 'active').storageGb).toBe(10);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run config/plans.test.js`
Expected: FAIL — `planLimitsResponse(null, 'trialing').storageGb` is `10`, not `3` (the second argument doesn't exist yet).

- [ ] **Step 3: Implement the trial limits override in `config/plans.js`**

Add this near the top of the file, after the `PLANS` export and before `planByPriceId`:

```js
// Trial groups get these two limits instead of falling back to Starter's real
// values — AI Meeting Notes is fully blocked (not a reduced quota), and storage
// is capped well below Starter's paid tier. Everything else about a trial
// group (seat counts, tier/name shape) still reads as Starter-shaped.
export const TRIAL_LIMITS = { storageGb: 3, aiNotesHoursPerMonth: 0 };
```

Then change `planLimitsResponse` to:

```js
export function planLimitsResponse(planKey, status) {
  const config = PLANS[planKey ?? 'starter'];
  const isTrialing = status === 'trialing';
  return {
    tier: config.tier,
    name: config.name,
    priceMonthlyUsd: config.priceMonthlyUsd,
    adminLimit: config.adminLimit,
    memberLimit: config.memberLimit,
    storageGb: isTrialing ? TRIAL_LIMITS.storageGb : config.storageGb,
    aiNotesHoursPerMonth: isTrialing ? TRIAL_LIMITS.aiNotesHoursPerMonth : config.aiNotesHoursPerMonth,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run config/plans.test.js`
Expected: PASS (all tests in the file, including the two new ones and the three pre-existing ones).

- [ ] **Step 5: Fix the two call sites**

In `models/billing.js`, line 12 currently reads:
```js
    limits: planLimitsResponse(row.plan),
```
Change to:
```js
    limits: planLimitsResponse(row.plan, row.status),
```

In `resolvers/billingResolvers.js`, line 18 currently reads:
```js
    plans: () => Object.keys(PLANS).map(planLimitsResponse),
```
`Array.prototype.map` invokes its callback with `(element, index, array)` — passing `planLimitsResponse` directly means `index` (a number) silently becomes the new `status` parameter. It's harmless today only because no array index will ever equal the string `'trialing'`, but it's a fragile trap now that `planLimitsResponse` takes a real second argument. Make it explicit:
```js
    plans: () => Object.keys(PLANS).map((planKey) => planLimitsResponse(planKey)),
```

- [ ] **Step 6: Write the failing test in `models/billing.test.js`**

First, update the top-of-file import (find the existing line `const { upsertBillingFromSubscription } = await import('./billing.js');`) to also pull in `getOrCreateBilling`:
```js
const { upsertBillingFromSubscription, getOrCreateBilling } = await import('./billing.js');
```

Then add this new `describe` block at the end of the file:

```js
describe('getOrCreateBilling', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('returns trial-tier limits for a group whose billing row already exists and is trialing', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          group_id: 'g1',
          status: 'trialing',
          plan: null,
          trial_ends_at: new Date(Date.now() + 10 * 86_400_000),
          current_period_end: null,
        },
      ],
    });

    const result = await getOrCreateBilling('g1');

    expect(result.limits.storageGb).toBe(3);
    expect(result.limits.aiNotesHoursPerMonth).toBe(0);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run models/billing.test.js`
Expected: FAIL — before Step 5's edit, `result.limits.storageGb` is `10`, not `3`.

- [ ] **Step 8: Run the full test to verify it passes (Step 5's edit already applied)**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run models/billing.test.js config/plans.test.js`
Expected: PASS — all tests in both files.

- [ ] **Step 9: Run the full backend suite**

Run: `cd /Users/eugenelinsangan/crm-proj && npm test`
Expected: PASS — every test file, including `resolvers/billingResolvers.test.js` if it exists (check `ls resolvers/billingResolvers.test.js` first; if present it must still pass unchanged, since Step 5's `.map` fix doesn't change `plans`'s actual output).

- [ ] **Step 10: Commit**

```bash
cd /Users/eugenelinsangan/crm-proj
git add config/plans.js config/plans.test.js models/billing.js models/billing.test.js resolvers/billingResolvers.js
git commit -m "feat: add trial-tier limits (3GB storage, 0 AI-notes hours)"
```

---

### Task 2: Backend — block AI Meeting Notes for trialing groups

**Files:**
- Modify: `resolvers/meetingRecordingResolvers.js`
- Test: `resolvers/meetingRecordingResolvers.test.js`

**Interfaces:**
- Consumes: `getOrCreateBilling(groupId)` from `models/billing.js` (already imported in this file) — returns `{ status, limits: { storageGb, aiNotesHoursPerMonth, ... }, ... }` per Task 1.
- Produces: a `TRIAL_FEATURE_LOCKED` `GraphQLError` thrown by `requestMeetingRecordingUploadUrl` and `finishMeetingRecording` whenever the caller's group has `billing.status === 'trialing'`.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `resolvers/meetingRecordingResolvers.test.js`, inside the existing `describe('requestMeetingRecordingUploadUrl', ...)` block (near the other quota/eligibility tests):

```js
  it('rejects a trialing group even for a continuing session (created: false)', async () => {
    getOrCreateBilling.mockResolvedValueOnce({ status: 'trialing', limits: { aiNotesHoursPerMonth: 0 } });
    getOrCreateSession.mockResolvedValueOnce({ sessionId: 's1', groupId: 'g1', createdBy: 'admin:u1', status: 'recording', created: false });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 1, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/paid plan/i);
  });

  it('rejects a trialing group before ever fetching quota usage', async () => {
    getOrCreateBilling.mockResolvedValueOnce({ status: 'trialing', limits: { aiNotesHoursPerMonth: 0 } });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/paid plan/i);
    expect(getOrCreateAiNotesUsage).not.toHaveBeenCalled();
  });
```

Add this test inside a `describe('finishMeetingRecording', ...)` block (find the existing one in the file — there should already be tests calling `meetingRecordingResolvers.Mutation.finishMeetingRecording`):

```js
  it('rejects a trialing group before touching the session', async () => {
    getOrCreateBilling.mockResolvedValueOnce({ status: 'trialing', limits: { aiNotesHoursPerMonth: 0 } });

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow(/paid plan/i);
    expect(getSessionWithSegments).not.toHaveBeenCalled();
  });
```

This last test needs `getOrCreateBilling` imported into the test file's top-level destructure. Find this existing line:
```js
const { createUploadUrl } = await import('../config/r2.js');
```
Add a new line right after it:
```js
const { getOrCreateBilling } = await import('../models/billing.js');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run resolvers/meetingRecordingResolvers.test.js`
Expected: FAIL on all three new tests — trial status is not checked yet, so the calls either succeed or fail for a different reason (e.g. `finishMeetingRecording`'s test fails because `getSessionWithSegments` gets called after all).

- [ ] **Step 3: Add the `requireNotTrialing` helper and wire it into both mutations**

In `resolvers/meetingRecordingResolvers.js`, add this function after the imports, before `const meetingRecordingResolvers = {`:

```js
function requireNotTrialing(billing) {
  if (billing.status === 'trialing') {
    throw new GraphQLError('AI Meeting Notes requires a paid plan.', {
      extensions: { code: 'TRIAL_FEATURE_LOCKED' },
    });
  }
}
```

In `requestMeetingRecordingUploadUrl`, the resolver currently only fetches `billing` inside the `if (isNewSession)` block (for the existing quota check). Change it to fetch `billing` unconditionally at the top instead, check the trial gate immediately, and reuse that same `billing` value inside the `isNewSession` block — only `usage` needs its own fetch there now. Find this block:

```js
      const session = await getOrCreateSession(sessionId, groupId, uploadedBy);

      // Defense against cross-tenant reference: getOrCreateSession looks up by
      // sessionId alone, so a caller who knows/guesses another group's sessionId would
      // otherwise silently get that group's row back.
      if (session.groupId !== groupId) {
        throw new GraphQLError('Invalid recording session.', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // Derived from actual DB state (did getOrCreateSession just insert the row?),
      // not from the client-supplied segmentIndex — a client requesting uploads
      // starting at segmentIndex 1 must not be able to skip quota enforcement.
      const isNewSession = session.created;

      if (isNewSession) {
        const [usage, billing] = await Promise.all([
          getOrCreateAiNotesUsage(groupId),
          getOrCreateBilling(groupId),
        ]);
        try {
          checkAiNotesQuota(usage.secondsUsed, true, billing.limits.aiNotesHoursPerMonth);
        } catch (err) {
          throw new GraphQLError(err.message, { extensions: { code: 'AI_NOTES_QUOTA_EXCEEDED' } });
        }
      }
```

Replace it with:

```js
      const billing = await getOrCreateBilling(groupId);
      requireNotTrialing(billing);

      const session = await getOrCreateSession(sessionId, groupId, uploadedBy);

      // Defense against cross-tenant reference: getOrCreateSession looks up by
      // sessionId alone, so a caller who knows/guesses another group's sessionId would
      // otherwise silently get that group's row back.
      if (session.groupId !== groupId) {
        throw new GraphQLError('Invalid recording session.', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // Derived from actual DB state (did getOrCreateSession just insert the row?),
      // not from the client-supplied segmentIndex — a client requesting uploads
      // starting at segmentIndex 1 must not be able to skip quota enforcement.
      const isNewSession = session.created;

      if (isNewSession) {
        const usage = await getOrCreateAiNotesUsage(groupId);
        try {
          checkAiNotesQuota(usage.secondsUsed, true, billing.limits.aiNotesHoursPerMonth);
        } catch (err) {
          throw new GraphQLError(err.message, { extensions: { code: 'AI_NOTES_QUOTA_EXCEEDED' } });
        }
      }
```

In `finishMeetingRecording`, find:

```js
    finishMeetingRecording: async (_, { sessionId }, context) => {
      const groupId = requireGroup(context);

      const { session, segments } = await getSessionWithSegments(sessionId, groupId);
```

Replace with:

```js
    finishMeetingRecording: async (_, { sessionId }, context) => {
      const groupId = requireGroup(context);

      const billing = await getOrCreateBilling(groupId);
      requireNotTrialing(billing);

      const { session, segments } = await getSessionWithSegments(sessionId, groupId);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/eugenelinsangan/crm-proj && npx vitest run resolvers/meetingRecordingResolvers.test.js`
Expected: PASS — all tests in the file, including the three new ones and every pre-existing test (the module-level `getOrCreateBilling` mock defaults to `{ limits: { tier: 'STARTER', aiNotesHoursPerMonth: 5 } }`, which has no `status` field, so `requireNotTrialing` passes through unaffected for every test that doesn't explicitly set `status: 'trialing'`).

- [ ] **Step 5: Run the full backend suite**

Run: `cd /Users/eugenelinsangan/crm-proj && npm test`
Expected: PASS — every test file.

- [ ] **Step 6: Commit**

```bash
cd /Users/eugenelinsangan/crm-proj
git add resolvers/meetingRecordingResolvers.js resolvers/meetingRecordingResolvers.test.js
git commit -m "feat: block AI Meeting Notes for trialing groups (TRIAL_FEATURE_LOCKED)"
```

---

### Task 3: Frontend — block Record for trial accounts, with an upgrade link

**Files:**
- Modify: `src/hooks/useMeetingRecorder.ts`
- Modify: `src/components/notes/RecordingPanel.tsx`

**Interfaces:**
- Consumes: `useBilling()` from `../../context/BillingContext` — returns `{ billing: Billing | null, ... }`; `Billing.status` is a plain string (`'trialing'`, `'active'`, etc. — see `src/types/index.ts`).
- Produces: `useMeetingRecorder(ownerId: string, onComplete: (note: FinishedMeetingNote) => void, billingStatus: string | null)` — a new required third parameter. `start()` returns early with an error, without ever calling `getUserMedia`, when `billingStatus === 'trialing'`.

- [ ] **Step 1: Update `useMeetingRecorder`'s signature and `start()`**

In `src/hooks/useMeetingRecorder.ts`, find:

```ts
export function useMeetingRecorder(ownerId: string, onComplete: (note: FinishedMeetingNote) => void) {
```

Change to:

```ts
export function useMeetingRecorder(
  ownerId: string,
  onComplete: (note: FinishedMeetingNote) => void,
  billingStatus: string | null,
) {
```

Find, inside `start()`:

```ts
    setError(null);
    setWarning(null);

    // Gate before requesting mic permissions — an admin should see the quota block
    // coming rather than hit it cold mid-click. If the usage check itself fails, don't
    // block on it: the backend's own per-segment check (enqueueSegment) is the
    // authoritative backstop.
    try {
```

Change to:

```ts
    setError(null);
    setWarning(null);

    if (billingStatus === 'trialing') {
      setError('AI Meeting Notes requires a paid plan.');
      return;
    }

    // Gate before requesting mic permissions — an admin should see the quota block
    // coming rather than hit it cold mid-click. If the usage check itself fails, don't
    // block on it: the backend's own per-segment check (enqueueSegment) is the
    // authoritative backstop.
    try {
```

Find the `start` callback's dependency array:

```ts
  }, [beginSegment, teardownCapture]);
```

Change to:

```ts
  }, [beginSegment, teardownCapture, billingStatus]);
```

- [ ] **Step 2: Update `RecordingPanel.tsx` to pass billing status and show the upgrade link**

Find the imports at the top of `src/components/notes/RecordingPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Banner';
import { IconMic, IconStop } from '../layout/icons';
import {
  canCaptureTabAudio,
  canRecordAudio,
  useMeetingRecorder,
} from '../../hooks/useMeetingRecorder';
import {
  getMyAiNotesUsage,
  formatHours,
  type FinishedMeetingNote,
  type AiNotesUsage,
} from '../../lib/meetingRecordingApi';
```

Change to:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Banner';
import { IconMic, IconStop } from '../layout/icons';
import {
  canCaptureTabAudio,
  canRecordAudio,
  useMeetingRecorder,
} from '../../hooks/useMeetingRecorder';
import {
  getMyAiNotesUsage,
  formatHours,
  type FinishedMeetingNote,
  type AiNotesUsage,
} from '../../lib/meetingRecordingApi';
import { useBilling } from '../../context/BillingContext';
```

Find:

```tsx
  const recorder = useMeetingRecorder(ownerId, onNoteReady);
  const { status, elapsedMs, segments, error, warning, tabAudioCaptured, recoverable } = recorder;
```

Change to:

```tsx
  const { billing } = useBilling();
  const recorder = useMeetingRecorder(ownerId, onNoteReady, billing?.status ?? null);
  const { status, elapsedMs, segments, error, warning, tabAudioCaptured, recoverable } = recorder;
```

Find the error banner near the end of the file:

```tsx
      {error && (
        <div className="mt-2.5">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
```

Change to:

```tsx
      {error && (
        <div className="mt-2.5">
          <Banner tone="error">
            {error}
            {billing?.status === 'trialing' && (
              <>
                {' '}
                <Link to="/app/billing" className="underline underline-offset-2">
                  Upgrade your plan
                </Link>
                .
              </>
            )}
          </Banner>
        </div>
      )}
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/eugenelinsangan/crm-frontend && npx tsc -b --noEmit`
Expected: clean, no output, exit 0.

- [ ] **Step 4: Lint**

Run: `cd /Users/eugenelinsangan/crm-frontend && npm run lint`
Expected: no new warnings on `src/hooks/useMeetingRecorder.ts` or `src/components/notes/RecordingPanel.tsx`.

- [ ] **Step 5: Commit**

```bash
cd /Users/eugenelinsangan/crm-frontend
git add src/hooks/useMeetingRecorder.ts src/components/notes/RecordingPanel.tsx
git commit -m "feat: block Record for trial accounts with an upgrade link"
```

---

### Task 4: Live end-to-end verification

**Files:** none (verification only — no new files)

**Interfaces:** none

- [ ] **Step 1: Backend — verify a real trialing account is rejected**

Use the existing test account `paddle-verify-final@example.com` (trial status, no active Paddle plan, created earlier this session) against the local dev server (`npm run dev` in both repos, or against production if the account exists there too — check which environment has this account first via a quick login attempt). Sign in, capture the session's auth cookie/token, then call `requestMeetingRecordingUploadUrl` directly:

```bash
curl -s -X POST http://localhost:4000/ \
  -H "Content-Type: application/json" \
  -H "Cookie: <the session cookie from signing in>" \
  -d '{"query":"mutation { requestMeetingRecordingUploadUrl(sessionId: \"verify-trial-1\", segmentIndex: 0, contentType: \"audio/webm\", sizeBytes: 1000) { uploadUrl } }"}'
```

Expected: a GraphQL error response containing `"code":"TRIAL_FEATURE_LOCKED"` and the message `AI Meeting Notes requires a paid plan.` — not an `uploadUrl`.

- [ ] **Step 2: Backend — verify a paid-plan account is unaffected (regression check)**

Repeat Step 1 against a group with `status: 'active'` and a real plan (any existing paid test account from earlier session work). Expected: a normal successful response containing `uploadUrl` and `key` — proves the trial gate doesn't accidentally block paid accounts.

- [ ] **Step 3: Frontend — verify the UI block, using the Browser pane**

Sign in as `paddle-verify-final@example.com` in the Browser pane, navigate to Notes, and click Record. Expected: no microphone permission prompt appears (proving `getUserMedia` was never called), and the panel shows an error banner reading "AI Meeting Notes requires a paid plan. Upgrade your plan." with "Upgrade your plan" as a working link to `/app/billing`. Click the link and confirm it navigates to the Billing page.

- [ ] **Step 4: Frontend — verify a paid-plan account still sees the normal flow (regression check)**

Sign in as a paid-plan test account, navigate to Notes. Expected: the Record button is present and enabled (no trial-block message), matching pre-existing behavior — this plan changed nothing for non-trial accounts.

- [ ] **Step 5: Report results**

Summarize what was verified (or any deviation found) directly in the conversation — no separate report file needed for a plan this size.

---
