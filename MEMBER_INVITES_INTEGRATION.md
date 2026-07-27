# Member Email Invites — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md), which still covers setup, auth, and the `graphqlRequest` helper — use that as the base. This doc covers the **optional** email invite sent when a user adds a member.

## How it works

`addMember` can optionally email the new member their portal link and login credentials. Sending is done through **the inviting user's own Gmail account** (via an App Password), not a shared system mailbox — so each user configures their own sender credentials once, and every invite they send afterward goes out "from" them.

```
updateEmailCredentials(email, appPassword)
        │  (one-time setup, per user — encrypted at rest)
        ▼
addMember(..., sendInvite: true)
        │
        ├─ no credentials configured? → fails immediately, member is NOT created
        │
        ├─ credentials configured → member IS created, then an email is attempted
        │       ├─ send succeeds → inviteSent: true
        │       └─ send fails (bad password, Gmail rate limit, etc.) → inviteSent: false, inviteError: "<reason>"
        │
        └─ sendInvite omitted/false → member created, no email attempt, inviteSent: null
```

**Important distinction**: a missing/unconfigured credentials error blocks member creation entirely (nothing is created — the caller should set up credentials first, or retry without `sendInvite`). An actual send failure (wrong password, Gmail down, etc.) does **not** roll back the member — they're already created, and the mutation still returns successfully with `inviteSent: false` so you can show "member added, but the invite email failed" and offer a retry path (there's no resend mutation yet — resending means calling `addMember`'s email step again isn't possible after creation, so for now a failed invite means telling the admin to share credentials manually).

**The email must be a Gmail App Password**, not the account's normal login password — Gmail's SMTP rejects normal passwords for third-party apps like this one. The user generates one from their Google Account → Security → 2-Step Verification → App Passwords (requires 2FA to be enabled on that Gmail account).

## Auth

| Operation | Type | Auth required | Notes |
|---|---|---|---|
| `myEmailCredentials` | Query | **user** | returns `{ email, updatedAt }` if configured, `null` if not — never returns the password |
| `updateEmailCredentials(email, appPassword)` | Mutation | **user** | saves or overwrites your Gmail sender credentials (upsert — same call for first-time setup and updates) |
| `addMember(..., sendInvite)` | Mutation | **user** | `sendInvite` is optional and defaults to no email; see flow above |

## TypeScript types

```ts
export interface EmailCredentials {
  email: string;
  updatedAt: string;
}

// Member gains two fields, only ever populated by addMember's response —
// null on every other operation that returns a Member (getAllMembers, etc.)
export interface Member {
  uuid: string;
  username: string;
  email: string;
  groupId: string | null;
  createdAt: string | null;
  inviteSent: boolean | null;
  inviteError: string | null;
}
```

## Operations

```ts
const MY_EMAIL_CREDENTIALS = `
  query MyEmailCredentials {
    myEmailCredentials { email updatedAt }
  }
`;

const UPDATE_EMAIL_CREDENTIALS = `
  mutation UpdateEmailCredentials($email: String!, $appPassword: String!) {
    updateEmailCredentials(email: $email, appPassword: $appPassword) { email updatedAt }
  }
`;

const ADD_MEMBER_WITH_INVITE = `
  mutation AddMember($username: String!, $email: String!, $password: String!, $sendInvite: Boolean) {
    addMember(username: $username, email: $email, password: $password, sendInvite: $sendInvite) {
      uuid username email createdAt
      inviteSent
      inviteError
    }
  }
`;

// usage — with invite:
await graphqlRequest(ADD_MEMBER_WITH_INVITE, {
  username: 'jane', email: 'jane@example.com', password: 'secret123', sendInvite: true,
});

// usage — without invite (existing behavior, unchanged):
await graphqlRequest(ADD_MEMBER_WITH_INVITE, {
  username: 'jane', email: 'jane@example.com', password: 'secret123', sendInvite: false,
});
```

If `sendInvite: true` and the user hasn't configured credentials, this throws with `extensions.code === 'EMAIL_CREDENTIALS_NOT_CONFIGURED'` — catch this specifically and prompt them to `UPDATE_EMAIL_CREDENTIALS` first, rather than showing a generic error.

## Suggested UI

- A **"Email Settings"** section (e.g. under account settings): call `MY_EMAIL_CREDENTIALS` to show whether it's configured (`"Sending as jane@gmail.com"` / `"Not set up"`), with a form (Gmail address + app password) that calls `UPDATE_EMAIL_CREDENTIALS`. Link to Google's App Password help page, since most users won't know what that is.
- On the **"Add Member"** form: a "Send invite email" checkbox. If unchecked, behavior is exactly what's already built. If checked and credentials aren't configured, catch `EMAIL_CREDENTIALS_NOT_CONFIGURED` and redirect to the Email Settings section instead of just showing a raw error.
- After a successful `addMember` call with `sendInvite: true`, check `inviteSent` — if `false`, show the member was added but flag the email failure (`inviteError`) so the admin knows to share credentials another way.
