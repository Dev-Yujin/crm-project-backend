# Trial-tier limits: block AI Meeting Notes, cap storage at 3GB

## Problem

Trial-status groups (`group_billing.status === 'trialing'`) currently receive
Starter-plan-level limits by default (10GB storage, 5 AI-notes hours/month),
because `planLimitsResponse` falls back to the Starter config whenever a
group has no `plan` selected yet — which is always true during trial. This
was a reasonable default at the time, but it means a trial account currently
gets the same AI Meeting Notes access and nearly the same storage as a
paying Starter customer, for free.

## Goals

- Trial accounts cannot use AI Meeting Notes at all (not a reduced quota —
  zero access), enforced in both the backend (defense-in-depth; the API
  must reject it even if a client bypasses the UI) and the frontend (a
  clear, honest UX rather than a request that silently fails).
- Trial accounts are capped at 3GB total storage instead of Starter's 10GB.
- Once a group leaves trial (subscribes to a paid plan), it immediately
  gets that plan's real limits — nothing trial-specific persists.

## Non-goals

- **Rate limiting** and **a security vulnerability scan** were part of the
  original request but are independent concerns, tracked and handled
  separately from this spec (rate limiting is a new cross-cutting API
  concern unrelated to trial status; a vulnerability scan is an audit, not
  a feature to design and build).
- Restricting admin/member seat counts for trial accounts — not requested;
  trial keeps Starter's seat limits (1 admin, 10 members).
- Metering meeting-recording storage into `group_storage` — irrelevant
  here since trial accounts can't create recordings at all, so there's
  nothing of theirs to meter. (This remains a separately-tracked, deferred
  question for paid accounts from the meeting-notes feature's final
  review — out of scope for this spec.)

## Architecture

### Backend

**`config/plans.js`** — add a `TRIAL_LIMITS` constant:
```js
export const TRIAL_LIMITS = { storageGb: 3, aiNotesHoursPerMonth: 0 };
```
`planLimitsResponse(planKey, status)` gains a second parameter: when
`status === 'trialing'`, `storageGb` and `aiNotesHoursPerMonth` come from
`TRIAL_LIMITS` instead of the Starter fallback; every other field (tier,
name, priceMonthlyUsd, adminLimit, memberLimit) is unchanged — trial still
reads as "Starter-shaped" for everything except these two numbers. Existing
callers that don't pass `status` (the public plans list in
`billingResolvers.js`, which lists real paid tiers with a real `planKey`,
never `null`) are unaffected — `status` defaults to `undefined`, which
doesn't match `'trialing'`.

**`models/billing.js`** — the one caller that maps a real group's row
(`mapBillingRow` or equivalent) passes `row.status` through:
`planLimitsResponse(row.plan, row.status)`.

**`resolvers/meetingRecordingResolvers.js`** — a new explicit gate, not a
repurposing of the existing hours-quota check (that check's messaging is
about *usage*, not *eligibility* — reusing it with a 0-hour limit would
show a trial user a confusing "you've used all 0 of your hours" message
instead of "this needs a paid plan"). Add a `requireNotTrialing(billing)`
helper (or inline check), thrown as a `GraphQLError` with
`extensions: { code: 'TRIAL_FEATURE_LOCKED' }` and message `'AI Meeting
Notes requires a paid plan.'`.

Implementation note for `requestMeetingRecordingUploadUrl`: today it only
fetches `billing` *inside* the `isNewSession` branch (for the existing
quota check on new sessions) — every other segment of an in-progress
session skips fetching it entirely. For the trial gate to act as real
defense-in-depth on every call (not just session-start), fetch `billing`
unconditionally at the top of the resolver instead, check
`requireNotTrialing(billing)` immediately, then reuse that same `billing`
value inside the existing `isNewSession` block for the quota check (only
`usage` needs its own fetch there now, not `billing` too). This is a
small simplification of the existing code, not just an addition.

`finishMeetingRecording` fetches `billing` and checks
`requireNotTrialing(billing)` at its top as well, since a session could in
principle have been started before a downgrade to trial (edge case, but
the check is cheap and consistent to have in both places).

**Storage cap** — no new code. `checkStorageQuota` (in
`utils/attachments.js`) already takes `billing.limits.storageGb` as a
parameter at the task-attachment-upload call site in
`taskResolvers.js`; once trial groups report `storageGb: 3` from the
`config/plans.js` change above, the existing over-quota rejection and its
existing message ("This upload would exceed your plan's storage quota
(3GB). Remove some files or upgrade your plan.") apply automatically.

### Frontend

**`useMeetingRecorder.ts`** — `start()` checks `billing.status ===
'trialing'` as its very first step, before requesting mic permission and
before the existing usage-quota check. If trialing, don't record; set the
error/message state to the upgrade-prompt text and return early. The hook
needs `billing` passed in from `RecordingPanel.tsx`, which does not
currently import `useBilling()` at all — this is a new addition to that
component (`Billing.tsx` already uses the context; `RecordingPanel` does
not yet).

**`RecordingPanel.tsx`** — no structural change to visibility: the Record
button and panel stay visible and clickable for trial accounts (per the
approved "hard block with upgrade prompt" UX — the feature should be
discoverable, not hidden). Clicking Record while trialing shows the block
message via the panel's existing error/message banner (no new banner
component), with a link to `/app/billing`.

**Storage** — no new UI. `Billing.tsx`'s existing storage-used display and
the existing over-quota error banner (wherever task-attachment upload
errors already surface) both already render whatever `storageGb` value the
backend returns — once that value is 3 for trial groups, they display
correctly with no code change.

## Error handling

| Scenario | Backend | Frontend |
|---|---|---|
| Trial account clicks Record | N/A (blocked client-side before any request) | Shows upgrade-prompt message, does not call `getUserMedia` or any mutation |
| Trial account bypasses the UI and calls `requestMeetingRecordingUploadUrl`/`finishMeetingRecording` directly | `GraphQLError` code `TRIAL_FEATURE_LOCKED`, message "AI Meeting Notes requires a paid plan." | N/A (not reachable through normal UI) |
| Trial account uploads a task attachment that would exceed 3GB | Existing `checkStorageQuota` throws (unchanged message, now with the 3GB number) | Existing attachment-upload error handling (unchanged) surfaces it |

## Testing

- `config/plans.js` / wherever `planLimitsResponse` is tested: trial status
  returns `storageGb: 3, aiNotesHoursPerMonth: 0`; a non-trialing status
  with `plan: null` (edge case, shouldn't really occur) still falls back to
  Starter as before; a real paid plan's limits are unaffected by status.
- `meetingRecordingResolvers.test.js`: `requestMeetingRecordingUploadUrl`
  and `finishMeetingRecording` both reject with `TRIAL_FEATURE_LOCKED` when
  the caller's billing status is `'trialing'`, regardless of usage/quota
  state.
- `useMeetingRecorder`/`RecordingPanel`: no existing automated test
  coverage for this hook in the frontend repo (matches the rest of this
  feature) — verified manually against production, same as the rest of
  the meeting-notes pipeline.
