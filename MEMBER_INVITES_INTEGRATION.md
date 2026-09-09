# Member Email Invites — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md), which still covers setup, auth, and the `graphqlRequest` helper — use that as the base. This doc covers the **optional** email invite sent when a user adds a member.

## How it works

`addMember` can optionally email the new member their portal link and login credentials. Sending goes through **Resend**, from one shared sender address configured on the backend (`RESEND_FROM_EMAIL`) — there's no per-user setup, and every invite looks the same regardless of who sent it.

```
addMember(..., sendInvite: true)
        │
        ├─ member is always created
        │
        └─ sendInvite: true → an email is attempted via Resend
                ├─ send succeeds → inviteSent: true
                └─ send fails (bad address, Resend outage, etc.) → inviteSent: false, inviteError: "<reason>"

sendInvite omitted/false → member created, no email attempt, inviteSent: null
```

Unlike the old Gmail-based flow, there's no "credentials not configured" failure mode anymore — sending is always available once the backend has `RESEND_API_KEY` set, so `addMember` never fails to create the member because of email setup.

## Auth

| Operation | Type | Auth required | Notes |
|---|---|---|---|
| `addMember(..., sendInvite)` | Mutation | **user** | `sendInvite` is optional and defaults to no email; see flow above |

## TypeScript types

```ts
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

## Suggested UI

- On the **"Add Member"** form: a "Send invite email" checkbox. If unchecked, behavior is exactly what's already built.
- After a successful `addMember` call with `sendInvite: true`, check `inviteSent` — if `false`, show the member was added but flag the email failure (`inviteError`) so the admin knows to share credentials another way.
