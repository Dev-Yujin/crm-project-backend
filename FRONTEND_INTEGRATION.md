# Frontend Integration Guide (React + Vite + TypeScript)

This backend exposes a single GraphQL endpoint (Apollo Server) at `http://<ip>:<port>/`, backed by:
- **Supabase Auth** — sign up / login / Google OAuth for **users** (staff/admin accounts)
- **Postgres (Supabase pooler)** — `members` table (CRM staff added by users), `groups` table (which group each user/member belongs to)
- **Firebase Realtime Database** — `departments`, `services`, `taskStatuses`, `clients`, `tasks`

No GraphQL client library is used here — just plain `fetch()` POSTs against the URL/port. The only package you need is `@supabase/supabase-js`, for Google Sign In/Sign Up.

Daily/weekly/monthly recurring tasks are a separate feature layered on top of `Task` — see [RECURRING_TASKS_INTEGRATION.md](./RECURRING_TASKS_INTEGRATION.md).

How multi-tenant data isolation ("groups") works, and how a user joins a teammate's group, is also a separate doc — see [GROUPS_INTEGRATION.md](./GROUPS_INTEGRATION.md). The short version, since it affects auth on almost everything below: every account automatically belongs to exactly one **group** the moment it's created (no setup step needed), every piece of data (`clients`, `tasks`, `members`, `departments`, `services`, `taskStatuses`, `recurringTasks`) belongs to exactly one group, and a signed-in user only ever sees their own group's data — groupId is always derived server-side from their session, never passed as an argument.

Optionally emailing a new member their portal link + credentials when you `addMember` them is also its own doc — see [MEMBER_INVITES_INTEGRATION.md](./MEMBER_INVITES_INTEGRATION.md).

There are two actors in this system:
- **user** — a Supabase Auth account (owns login, Google sign-in). Required for all create/delete/review/management mutations.
- **member** — a row in the `members` table, added by a user. Members currently have **no login/session mechanism**, so member-facing mutations (`submitTask`, `editTask`) are unauthenticated and take a `memberUuid` argument directly. A member inherits their group automatically from whoever added them (`addMember` stamps the creating user's group onto the new member).

The three **public catalog queries** members rely on without logging in — `services`, `departments`, `taskStatuses` — are the one exception to "groupId is always server-derived": since there's no session to derive a group from, they accept an optional `groupId` argument. A member gets their own `groupId` from `loginMember`/`currentMember` (see §4/§6) and passes it along explicitly on every call. If you call one of these while signed in as a user, omit the argument — your session's group wins automatically.

---

## 1. Setup

```bash
npm install @supabase/supabase-js
```

`.env` (Vite requires the `VITE_` prefix):

```
VITE_SUPABASE_URL=https://aapqxpauzjkeqjjjziyj.supabase.co
VITE_SUPABASE_ANON_KEY=<the anon public key>
VITE_GRAPHQL_URL=http://<your-ip>:4000/
```

The anon key is safe to expose in frontend code — it's designed for that.

---

## 2. Google Sign In / Sign Up

Same button does both — the first time a Google account is used it's a sign-up, every time after that it's a sign-in. Supabase Auth handles this distinction automatically.

**`src/lib/supabase.ts`**
```ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
```

**Trigger the Google flow** (e.g. on a button click)
```ts
async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/auth/callback' },
  });
  if (error) console.error(error.message);
  // Browser now redirects to Google's consent screen, then back to redirectTo.
}
```

**Redirect target must be allow-listed in Supabase.** Whatever URL you pass as `redirectTo` (e.g. `https://yourapp.com/auth/callback` or `http://localhost:5173/auth/callback`) has to be added in **Supabase Dashboard → Authentication → URL Configuration → Redirect URLs**, or Google will reject the request with `redirect_uri_mismatch`.

**Capture the session on the redirect page** (`/auth/callback` route, runs once on mount)
```ts
import { useEffect } from 'react';

function AuthCallback() {
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        // session.access_token -> store it / use for GraphQL calls
        // redirect to your app's main page
      }
    });
  }, []);

  return <p>Signing you in...</p>;
}
```

**Watch session changes anywhere in the app** (put this in an auth context provider at the root)
```ts
useEffect(() => {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    // update your stored access token / user state here
  });
  return () => subscription.unsubscribe();
}, []);
```

**Sign out**
```ts
await supabase.auth.signOut();
```

### Email/password sign up & sign in

Same `supabase` client, different methods — useful if you want a non-Google option too:
```ts
// Sign up
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: { data: { name } }, // stored in user_metadata
});
// data.session is null until the user confirms their email (Supabase default)

// Sign in
const { data, error } = await supabase.auth.signInWithPassword({ email, password });
// data.session.access_token -> use as Bearer token for GraphQL
```

---

## 3. Calling the GraphQL API (plain `fetch`, no library)

```ts
// src/lib/graphql.ts
import { supabase } from './supabase';

const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL;

export async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token && { Authorization: `Bearer ${session.access_token}` }),
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (json.errors) {
    throw new Error(json.errors[0]?.message ?? 'GraphQL request failed');
  }

  return json.data as T;
}
```

It automatically grabs whatever Supabase session is active and attaches it as `Authorization: Bearer <token>`. Calls that don't require auth just ignore the header server-side.

**Example usage:**
```ts
const GET_SERVICES = `
  query GetServices {
    services { id name }
  }
`;

const { services } = await graphqlRequest<{ services: Service[] }>(GET_SERVICES);
```

**Error handling** — every mutation that requires a signed-in user throws a GraphQL error with `extensions.code === 'UNAUTHENTICATED'`. Since `graphqlRequest` above only surfaces `error.message`, check the raw response if you need the code:
```ts
const res = await fetch(GRAPHQL_URL, { /* ... */ });
const json = await res.json();
if (json.errors?.[0]?.extensions?.code === 'UNAUTHENTICATED') {
  // redirect to login
}
```

You may also see `extensions.code === 'NO_GROUP'` — this shouldn't happen for any normal signup (every account gets a group automatically, see "Groups" above), so treat it as a bug report rather than something to build a UI state around.

---

## 4. TypeScript types

```ts
// --- User / Auth ---
export interface User {
  id: string;
  email: string | null;
  name: string | null;
}

// --- Member ---
export interface Member {
  uuid: string;
  username: string;
  email: string;
  groupId: string | null; // inherited from whoever added them; use this for the services/departments/taskStatuses groupId arg
  createdAt: string | null;
  inviteSent: boolean | null; // only ever set by addMember's response — see MEMBER_INVITES_INTEGRATION.md
  inviteError: string | null;
}
export interface MemberAuthPayload {
  member: Member;
  token: string; // member JWT, 7-day expiry — separate from the Supabase user session
}

// --- Department ---
export interface DepartmentMember {
  uuid: string;
  username: string;
  email: string;
  assignedAt: string | null;
}
export interface Department {
  id: string;
  name: string;
  groupId: string;
  createdAt: string | null;
  members: DepartmentMember[];
}

// --- Service ---
export interface Service {
  id: string;
  name: string;
  groupId: string;
}

// --- Client ---
export interface Client {
  id: string;
  clientName: string;
  businessName: string;
  email: string;
  whatsappNumber: string | null;
  clientNotes: string | null;
  servicesAvailed: string[] | null; // Service IDs — join against Service[] to display names
  groupId: string;
  createdAt: string | null;
}

// --- Task Status --- (user-defined, e.g. "Pending", "On Going", "Done" — no fixed workflow)
export interface TaskStatus {
  id: string;
  name: string;
  groupId: string;
}

// --- Task ---
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface Submission {
  link: string;
  note: string | null;
  submittedBy: string; // member uuid
  submittedAt: string | null;
}
export interface Revision {
  id: string;
  comment: string;
  reviewedBy: string; // user id
  reviewedAt: string | null;
}
export interface Task {
  id: string;
  clientId: string;
  clientName: string;
  taskName: string;
  taskDescription: string;
  serviceId: string; // must be one of that client's servicesAvailed
  assignedMembers: string[]; // member uuids
  dueDate: string | null;
  createdBy: string | null; // user id
  priority: TaskPriority;
  statusId: string | null; // freely settable, references the TaskStatus catalog — no fixed workflow or gating
  departmentId: string | null; // optional, references the Department catalog — purely informational, not validated against assignedMembers
  groupId: string;
  createdAt: string | null;
  submission: Submission | null;
  revisions: Revision[];
  recurringTaskId: string | null; // set if auto-generated by a recurring task template — see RECURRING_TASKS_INTEGRATION.md
}
```

---

## 5. Quick reference — every operation

| Operation | Type | Auth required | Notes |
|---|---|---|---|
| `myGroup` / `joinGroup(joinCode)` | Query/Mutation | **user** | see [GROUPS_INTEGRATION.md](./GROUPS_INTEGRATION.md) |
| `currentUser(accessToken)` | Query | none | pass a token explicitly, mostly for debugging |
| `registerUser` / `loginUser` / `signInWithGoogle` | Mutation | none | prefer `supabase-js` directly (§2) instead |
| `signOutUser` | Mutation | none | prefer `supabase.auth.signOut()` |
| `members` | Query | **user** | full roster of the caller's own group; use to build "assign member" dropdowns |
| `addMember` / `deleteMember` | Mutation | **user** | only users manage members; new members are stamped with the creating user's `groupId` automatically; `addMember`'s optional `sendInvite` is documented in [MEMBER_INVITES_INTEGRATION.md](./MEMBER_INVITES_INTEGRATION.md) |
| `loginMember` | Mutation | none | member login, returns a member JWT (separate from the Supabase user session) plus the member's `groupId` |
| `currentMember(token)` | Query | none | verify/restore a stored member token; also returns `groupId` |
| `editMemberProfile` | Mutation | none | member editing their own profile; not yet tied to the login token — `uuid` is still a plain, unverified argument |
| `departments(groupId)` | Query | none for members (`groupId` arg required) / **user** (`groupId` derived from session, arg ignored) | members need to read their own department without login |
| `addDepartment` / `updateDepartment` / `deleteDepartment` | Mutation | **user** | scoped to the caller's group; deleting a department in use by a task doesn't cascade — leaves a dangling `departmentId` |
| `addMemberToDepartment` / `removeMemberFromDepartment` | Mutation | **user** | scoped to the caller's group; a member can currently belong to more than one department — nothing enforces exclusivity |
| `services(groupId)` | Query | none for members (`groupId` arg required) / **user** (`groupId` derived from session, arg ignored) | public catalog (e.g. "Web Development", "Video Editing"), scoped per group |
| `addService` / `updateService` / `deleteService` | Mutation | **user** | scoped to the caller's group; deleting a service in use by a client/task doesn't cascade — leaves a dangling ID |
| `clients` | Query | **user** | client records are treated as sensitive; scoped to the caller's group |
| `addClient` / `deleteClient` / `editClient` | Mutation | **user** | `servicesAvailed` must be IDs that exist in the caller's group's `services` catalog |
| `clientInquiry` | Mutation | none | public — submitted by a prospect with no account; **not** scoped to a group (there's no way for an anonymous prospect to indicate one) |
| `taskStatuses(groupId)` | Query | none for members (`groupId` arg required) / **user** (`groupId` derived from session, arg ignored) | public catalog of user-defined task statuses (e.g. "Pending", "On Going", "Done"), scoped per group |
| `addTaskStatus` / `updateTaskStatus` / `deleteTaskStatus` | Mutation | **user** | scoped to the caller's group; same non-cascading caveat as services — deleting one in use leaves a dangling `statusId` on any task referencing it |
| `addTask` / `editTask` `departmentId` arg | Mutation arg | **user** | optional; must reference an existing `Department` in the caller's group. Same non-cascading caveat — deleting a department in use leaves a dangling `departmentId` on any task referencing it. Purely informational (e.g. "this task belongs to the Video Editing dept.") — it is **not** validated against `assignedMembers`, so a task can be tagged to a department none of its assignees belong to |
| `tasks` | Query | **user** | all tasks in the caller's group |
| `tasksForMember(memberUuid)` | Query | none | filtered to one member's assigned tasks, scoped to that member's own group automatically — use for a "my tasks" screen |
| `addTask` / `deleteTask` / `reviewTask` | Mutation | **user** | scoped to the caller's group; `createdBy`/`reviewedBy` come from the session, not client input |
| `editTask` / `submitTask` | Mutation | none | member actions; `memberUuid` is self-declared |

"Auth required: user" means `graphqlRequest` needs an active Supabase session (it attaches the token automatically per §3). See the "Groups" section above for how `groupId` scoping actually works — it's not something you manage per-request for signed-in users, only for the three unauthenticated catalog queries.

**Client → Service → Task flow to build the UI around:** a service must exist in the `services` catalog before a client can avail it, and a task's `serviceId` must be one of the *specific client's* `servicesAvailed` — not just any service in the catalog. So the "add task" form should fetch the selected client's `servicesAvailed`, cross-reference against `services` for display names, and only offer those as options.

**There is no fixed task workflow.** `statusId` is freely settable via `addTask`/`editTask`, referencing whatever statuses your team has defined in the `taskStatuses` catalog (build that screen first). `submitTask` (member records a link/note) and `reviewTask` (user leaves a comment) are independent actions — neither one changes `statusId` automatically, and neither is gated by the task's current status. If you want submitting/reviewing to *also* move the status (e.g. to a "Submitted" or "Done" status), call `editTask` with the relevant `statusId` alongside/after those calls — the backend won't do it for you.

---

## 6. Operations reference

All of these are plain GraphQL query/mutation strings — pass them straight into `graphqlRequest` from §3.

### Members

```ts
const GET_MEMBERS = `
  query GetMembers {
    members { uuid username email groupId createdAt }
  }
`;

// Member login — separate from Google/user login in §2. Returns a member-scoped
// JWT (7-day expiry), NOT a Supabase session. Store it separately (e.g. its own
// localStorage key) and don't pass it as the GraphQL Authorization header —
// graphqlRequest (§3) only attaches the Supabase user session there.
// member.groupId is what you pass into the services/departments/taskStatuses
// groupId argument (§5) since a member has no session to derive it from.
const LOGIN_MEMBER = `
  mutation LoginMember($email: String!, $password: String!) {
    loginMember(email: $email, password: $password) {
      member { uuid username email groupId createdAt }
      token
    }
  }
`;

// Verify a stored member token is still valid / restore the member on app load
const CURRENT_MEMBER = `
  query CurrentMember($token: String!) {
    currentMember(token: $token) { uuid username email groupId createdAt }
  }
`;

const ADD_MEMBER = `
  mutation AddMember($username: String!, $email: String!, $password: String!) {
    addMember(username: $username, email: $email, password: $password) {
      uuid username email groupId createdAt
    }
  }
`;

const DELETE_MEMBER = `
  mutation DeleteMember($uuid: ID!) {
    deleteMember(uuid: $uuid) { uuid username email }
  }
`;

const EDIT_MEMBER_PROFILE = `
  mutation EditMemberProfile($uuid: ID!, $username: String, $email: String, $password: String) {
    editMemberProfile(uuid: $uuid, username: $username, email: $email, password: $password) {
      uuid username email groupId createdAt
    }
  }
`;

// usage
await graphqlRequest(ADD_MEMBER, { username: 'jane', email: 'jane@example.com', password: 'secret123' });
```

### Departments

```ts
// Signed in as a user: omit groupId, your session's group is used automatically.
// Signed in as a member (no session): pass groupId explicitly — from member.groupId (§4/§6).
const GET_DEPARTMENTS = `
  query GetDepartments($groupId: ID) {
    departments(groupId: $groupId) { id name groupId createdAt members { uuid username email assignedAt } }
  }
`;

const ADD_DEPARTMENT = `
  mutation AddDepartment($name: String!) {
    addDepartment(name: $name) { id name groupId createdAt members { uuid } }
  }
`;

const UPDATE_DEPARTMENT = `
  mutation UpdateDepartment($departmentId: ID!, $name: String!) {
    updateDepartment(departmentId: $departmentId, name: $name) { id name groupId }
  }
`;

const DELETE_DEPARTMENT = `
  mutation DeleteDepartment($departmentId: ID!) {
    deleteDepartment(departmentId: $departmentId) { id name }
  }
`;

const ADD_MEMBER_TO_DEPARTMENT = `
  mutation AddMemberToDepartment($departmentId: ID!, $memberUuid: ID!) {
    addMemberToDepartment(departmentId: $departmentId, memberUuid: $memberUuid) {
      uuid username email assignedAt
    }
  }
`;

const REMOVE_MEMBER_FROM_DEPARTMENT = `
  mutation RemoveMemberFromDepartment($departmentId: ID!, $memberUuid: ID!) {
    removeMemberFromDepartment(departmentId: $departmentId, memberUuid: $memberUuid)
  }
`;
```

### Services

The catalog of services the business offers. Build the "add service" screen first — clients and tasks both depend on this list existing.

```ts
// Signed in as a user: omit groupId. Signed in as a member (no session): pass
// it explicitly from member.groupId (§4/§6).
const GET_SERVICES = `
  query GetServices($groupId: ID) {
    services(groupId: $groupId) { id name groupId }
  }
`;

const ADD_SERVICE = `
  mutation AddService($name: String!) {
    addService(name: $name) { id name groupId }
  }
`;

const UPDATE_SERVICE = `
  mutation UpdateService($serviceId: ID!, $name: String!) {
    updateService(serviceId: $serviceId, name: $name) { id name groupId }
  }
`;

const DELETE_SERVICE = `
  mutation DeleteService($serviceId: ID!) {
    deleteService(serviceId: $serviceId) { id name }
  }
`;
```

### Clients

```ts
const GET_CLIENTS = `
  query GetClients {
    clients {
      id clientName businessName email whatsappNumber clientNotes servicesAvailed groupId createdAt
    }
  }
`;

const ADD_CLIENT = `
  mutation AddClient(
    $clientName: String!
    $businessName: String!
    $email: String!
    $whatsappNumber: String
    $clientNotes: String
    $servicesAvailed: [ID!]
  ) {
    addClient(
      clientName: $clientName
      businessName: $businessName
      email: $email
      whatsappNumber: $whatsappNumber
      clientNotes: $clientNotes
      servicesAvailed: $servicesAvailed
    ) {
      id clientName businessName email whatsappNumber clientNotes servicesAvailed groupId
    }
  }
`;

const DELETE_CLIENT = `
  mutation DeleteClient($clientId: ID!) {
    deleteClient(clientId: $clientId) { id clientName }
  }
`;

const EDIT_CLIENT = `
  mutation EditClient(
    $clientId: ID!
    $clientName: String
    $businessName: String
    $email: String
    $whatsappNumber: String
    $clientNotes: String
    $servicesAvailed: [ID!]
  ) {
    editClient(
      clientId: $clientId
      clientName: $clientName
      businessName: $businessName
      email: $email
      whatsappNumber: $whatsappNumber
      clientNotes: $clientNotes
      servicesAvailed: $servicesAvailed
    ) {
      id clientName businessName email whatsappNumber clientNotes servicesAvailed groupId
    }
  }
`;

// Public — put this on a marketing/contact page, no auth needed
const CLIENT_INQUIRY = `
  mutation ClientInquiry($clientName: String!, $email: String!, $message: String!) {
    clientInquiry(clientName: $clientName, email: $email, message: $message) {
      id clientName email message
    }
  }
`;
```

`servicesAvailed` on the add/edit client form should be a multi-select populated from `GET_SERVICES`, sending back the chosen service **IDs** — free-typed values will be rejected since the backend validates every ID exists in the catalog.

### Task Statuses

A user-managed catalog of task statuses — there's no fixed enum, your team defines whatever statuses make sense (e.g. "Pending", "On Going", "Blocked", "Done"). Build this screen before "add task", same as Services.

```ts
// Signed in as a user: omit groupId. Signed in as a member (no session): pass
// it explicitly from member.groupId (§4/§6).
const GET_TASK_STATUSES = `
  query GetTaskStatuses($groupId: ID) {
    taskStatuses(groupId: $groupId) { id name groupId }
  }
`;

const ADD_TASK_STATUS = `
  mutation AddTaskStatus($name: String!) {
    addTaskStatus(name: $name) { id name groupId }
  }
`;

const UPDATE_TASK_STATUS = `
  mutation UpdateTaskStatus($taskStatusId: ID!, $name: String!) {
    updateTaskStatus(taskStatusId: $taskStatusId, name: $name) { id name groupId }
  }
`;

const DELETE_TASK_STATUS = `
  mutation DeleteTaskStatus($taskStatusId: ID!) {
    deleteTaskStatus(taskStatusId: $taskStatusId) { id name }
  }
`;
```

### Tasks

```ts
const GET_TASKS = `
  query GetTasks {
    tasks {
      id clientId clientName taskName taskDescription serviceId
      assignedMembers dueDate createdBy priority statusId departmentId groupId createdAt recurringTaskId
      submission { link note submittedBy submittedAt }
      revisions { id comment reviewedBy reviewedAt }
    }
  }
`;

// Use this for a member's "my tasks" screen instead of GET_TASKS — no auth needed
const GET_TASKS_FOR_MEMBER = `
  query GetTasksForMember($memberUuid: ID!) {
    tasksForMember(memberUuid: $memberUuid) {
      id clientId clientName taskName taskDescription serviceId
      assignedMembers dueDate createdBy priority statusId departmentId groupId createdAt recurringTaskId
      submission { link note submittedBy submittedAt }
      revisions { id comment reviewedBy reviewedAt }
    }
  }
`;

const ADD_TASK = `
  mutation AddTask(
    $clientId: ID!
    $clientName: String!
    $taskName: String!
    $taskDescription: String!
    $serviceId: ID!
    $assignedMembers: [ID!]!
    $dueDate: String
    $priority: TaskPriority
    $statusId: ID
    $departmentId: ID
  ) {
    addTask(
      clientId: $clientId
      clientName: $clientName
      taskName: $taskName
      taskDescription: $taskDescription
      serviceId: $serviceId
      assignedMembers: $assignedMembers
      dueDate: $dueDate
      priority: $priority
      statusId: $statusId
      departmentId: $departmentId
    ) {
      id taskName statusId departmentId groupId serviceId assignedMembers priority
    }
  }
`;
// priority defaults to MEDIUM if omitted. serviceId must be one of the
// selected client's servicesAvailed (see the flow note above the table in §5).
// statusId is optional and, if provided, must reference an existing entry in the taskStatuses catalog.
// departmentId is optional and, if provided, must reference an existing entry in the departments catalog.

const EDIT_TASK = `
  mutation EditTask(
    $taskId: ID!
    $clientId: ID
    $clientName: String
    $taskName: String
    $taskDescription: String
    $serviceId: ID
    $assignedMembers: [ID!]
    $dueDate: String
    $priority: TaskPriority
    $statusId: ID
    $departmentId: ID
  ) {
    editTask(
      taskId: $taskId
      clientId: $clientId
      clientName: $clientName
      taskName: $taskName
      taskDescription: $taskDescription
      serviceId: $serviceId
      assignedMembers: $assignedMembers
      dueDate: $dueDate
      priority: $priority
      statusId: $statusId
      departmentId: $departmentId
    ) {
      id taskName taskDescription serviceId assignedMembers dueDate priority statusId departmentId groupId
    }
  }
`;
// This is how you change a task's status — pass whichever taskStatuses.id the
// user picked. There's no dedicated "set status" mutation; it's just a field edit.
// Same pattern for department — pass whichever departments.id it belongs to, or
// null to clear it. Not validated against assignedMembers.

const DELETE_TASK = `
  mutation DeleteTask($taskId: ID!) {
    deleteTask(taskId: $taskId) { id taskName }
  }
`;

// Member records/updates their submitted work; memberUuid must be in the task's
// assignedMembers. Callable anytime, any number of times — not gated by status,
// and doesn't change statusId itself.
const SUBMIT_TASK = `
  mutation SubmitTask($taskId: ID!, $memberUuid: ID!, $link: String!, $note: String) {
    submitTask(taskId: $taskId, memberUuid: $memberUuid, link: $link, note: $note) {
      id submission { link note submittedBy submittedAt }
    }
  }
`;

// User leaves a review comment, logged to the task's revision history.
// Callable anytime — not gated by status, and doesn't change statusId itself.
const REVIEW_TASK = `
  mutation ReviewTask($taskId: ID!, $comment: String!) {
    reviewTask(taskId: $taskId, comment: $comment) {
      id
      revisions { id comment reviewedBy reviewedAt }
    }
  }
`;
```

**There's no status flow diagram** — that's the point. `submitTask` and `reviewTask` just record data (a submission, a review comment); they don't touch `statusId`. If your UI wants "submitting moves it to a Submitted status" or "reviewing moves it to Done", make that an explicit second call to `EDIT_TASK` with the chosen `statusId` right after `SUBMIT_TASK`/`REVIEW_TASK` — the backend has no opinion on what that mapping should be.

`revisions` is still the audit trail / comment thread for the task detail view — every `reviewTask` call appends one entry, it just no longer carries a status value.

### Users (optional — see §2 for the recommended Google/email flows instead)

```ts
const REGISTER_USER = `
  mutation RegisterUser($name: String!, $email: String!, $password: String!) {
    registerUser(name: $name, email: $email, password: $password) {
      user { id email name }
      session { accessToken refreshToken expiresAt }
    }
  }
`;

const LOGIN_USER = `
  mutation LoginUser($email: String!, $password: String!) {
    loginUser(email: $email, password: $password) {
      user { id email name }
      session { accessToken refreshToken expiresAt }
    }
  }
`;
```
