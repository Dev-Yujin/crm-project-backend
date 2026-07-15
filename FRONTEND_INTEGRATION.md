# Frontend Integration Guide (React + Vite + TypeScript)

This backend exposes a single GraphQL endpoint (Apollo Server) at `http://<ip>:<port>/`, backed by:
- **Supabase Auth** — sign up / login / Google OAuth for **users** (staff/admin accounts)
- **Postgres (Supabase pooler)** — `members` table (CRM staff added by users)
- **Firebase Realtime Database** — `jobs`, `departments`, `services`, `clients`, `tasks`

No GraphQL client library is used here — just plain `fetch()` POSTs against the URL/port. The only package you need is `@supabase/supabase-js`, for Google Sign In/Sign Up.

There are two actors in this system:
- **user** — a Supabase Auth account (owns login, Google sign-in). Required for all create/delete/review/management mutations.
- **member** — a row in the `members` table, added by a user. Members currently have **no login/session mechanism**, so member-facing mutations (`submitTask`, `editTask`) are unauthenticated and take a `memberUuid` argument directly.

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
const GET_JOBS = `
  query GetJobs {
    jobs { id title createdAt members { uuid username email assignedAt } }
  }
`;

const { jobs } = await graphqlRequest<{ jobs: Job[] }>(GET_JOBS);
```

**Error handling** — every mutation that requires a signed-in user throws a GraphQL error with `extensions.code === 'UNAUTHENTICATED'`. Since `graphqlRequest` above only surfaces `error.message`, check the raw response if you need the code:
```ts
const res = await fetch(GRAPHQL_URL, { /* ... */ });
const json = await res.json();
if (json.errors?.[0]?.extensions?.code === 'UNAUTHENTICATED') {
  // redirect to login
}
```

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
  createdAt: string | null;
}

// --- Job ---
export interface JobMember {
  uuid: string;
  username: string;
  email: string;
  assignedAt: string | null;
}
export interface Job {
  id: string;
  title: string;
  createdAt: string | null;
  members: JobMember[];
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
  createdAt: string | null;
  members: DepartmentMember[];
}

// --- Service ---
export interface Service {
  id: string;
  name: string;
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
  createdAt: string | null;
}

// --- Task ---
export type TaskStatus = 'PENDING' | 'SUBMITTED' | 'FOR_REVISION' | 'COMPLETED';
export type ReviewDecision = 'FOR_REVISION' | 'COMPLETED';
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
  status: TaskStatus;
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
  status: TaskStatus;
  createdAt: string | null;
  submission: Submission | null;
  revisions: Revision[];
}
```

---

## 5. Quick reference — every operation

| Operation | Type | Auth required | Notes |
|---|---|---|---|
| `currentUser(accessToken)` | Query | none | pass a token explicitly, mostly for debugging |
| `registerUser` / `loginUser` / `signInWithGoogle` | Mutation | none | prefer `supabase-js` directly (§2) instead |
| `signOutUser` | Mutation | none | prefer `supabase.auth.signOut()` |
| `addMember` / `deleteMember` | Mutation | **user** | only users manage members |
| `editMemberProfile` | Mutation | none | member editing their own profile; no session to verify identity |
| `jobs` | Query | none | members need to read this without login |
| `addJob` / `addMemberToJob` / `removeMemberFromJob` | Mutation | **user** | |
| `departments` | Query | none | members need to read their own department without login |
| `addDepartment` / `addMemberToDepartment` / `removeMemberFromDepartment` | Mutation | **user** | a member can currently belong to more than one department — nothing enforces exclusivity |
| `services` | Query | none | public catalog (e.g. "Web Development", "Video Editing") |
| `addService` / `updateService` / `deleteService` | Mutation | **user** | deleting a service in use by a client/task doesn't cascade — leaves a dangling ID |
| `clients` | Query | **user** | client records are treated as sensitive |
| `addClient` / `deleteClient` / `editClient` | Mutation | **user** | `servicesAvailed` must be IDs that exist in the `services` catalog |
| `clientInquiry` | Mutation | none | public — submitted by a prospect with no account |
| `tasks` | Query | none | members need to read their assigned tasks |
| `addTask` / `deleteTask` / `reviewTask` | Mutation | **user** | `createdBy`/`reviewedBy` come from the session, not client input |
| `editTask` / `submitTask` | Mutation | none | member actions; `memberUuid` is self-declared |

"Auth required: user" means `graphqlRequest` needs an active Supabase session (it attaches the token automatically per §3).

**Client → Service → Task flow to build the UI around:** a service must exist in the `services` catalog before a client can avail it, and a task's `serviceId` must be one of the *specific client's* `servicesAvailed` — not just any service in the catalog. So the "add task" form should fetch the selected client's `servicesAvailed`, cross-reference against `services` for display names, and only offer those as options.

---

## 6. Operations reference

All of these are plain GraphQL query/mutation strings — pass them straight into `graphqlRequest` from §3.

### Members

```ts
const ADD_MEMBER = `
  mutation AddMember($username: String!, $email: String!, $password: String!) {
    addMember(username: $username, email: $email, password: $password) {
      uuid username email createdAt
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
      uuid username email createdAt
    }
  }
`;

// usage
await graphqlRequest(ADD_MEMBER, { username: 'jane', email: 'jane@example.com', password: 'secret123' });
```

### Jobs

```ts
const GET_JOBS = `
  query GetJobs {
    jobs { id title createdAt members { uuid username email assignedAt } }
  }
`;

const ADD_JOB = `
  mutation AddJob($title: String!) {
    addJob(title: $title) { id title createdAt members { uuid } }
  }
`;

const ADD_MEMBER_TO_JOB = `
  mutation AddMemberToJob($jobId: ID!, $memberUuid: ID!) {
    addMemberToJob(jobId: $jobId, memberUuid: $memberUuid) {
      uuid username email assignedAt
    }
  }
`;

const REMOVE_MEMBER_FROM_JOB = `
  mutation RemoveMemberFromJob($jobId: ID!, $memberUuid: ID!) {
    removeMemberFromJob(jobId: $jobId, memberUuid: $memberUuid)
  }
`;
```

### Departments

```ts
const GET_DEPARTMENTS = `
  query GetDepartments {
    departments { id name createdAt members { uuid username email assignedAt } }
  }
`;

const ADD_DEPARTMENT = `
  mutation AddDepartment($name: String!) {
    addDepartment(name: $name) { id name createdAt members { uuid } }
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
const GET_SERVICES = `
  query GetServices {
    services { id name }
  }
`;

const ADD_SERVICE = `
  mutation AddService($name: String!) {
    addService(name: $name) { id name }
  }
`;

const UPDATE_SERVICE = `
  mutation UpdateService($serviceId: ID!, $name: String!) {
    updateService(serviceId: $serviceId, name: $name) { id name }
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
      id clientName businessName email whatsappNumber clientNotes servicesAvailed createdAt
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
      id clientName businessName email whatsappNumber clientNotes servicesAvailed
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
      id clientName businessName email whatsappNumber clientNotes servicesAvailed
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

### Tasks

```ts
const GET_TASKS = `
  query GetTasks {
    tasks {
      id clientId clientName taskName taskDescription serviceId
      assignedMembers dueDate createdBy priority status createdAt
      submission { link note submittedBy submittedAt }
      revisions { id comment status reviewedBy reviewedAt }
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
    ) {
      id taskName status serviceId assignedMembers priority
    }
  }
`;
// priority defaults to MEDIUM if omitted. serviceId must be one of the
// selected client's servicesAvailed (see the flow note above the table in §5).

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
    ) {
      id taskName taskDescription serviceId assignedMembers dueDate priority
    }
  }
`;

const DELETE_TASK = `
  mutation DeleteTask($taskId: ID!) {
    deleteTask(taskId: $taskId) { id taskName }
  }
`;

// Member submits/resubmits their work; memberUuid must be in the task's assignedMembers
const SUBMIT_TASK = `
  mutation SubmitTask($taskId: ID!, $memberUuid: ID!, $link: String!, $note: String) {
    submitTask(taskId: $taskId, memberUuid: $memberUuid, link: $link, note: $note) {
      id status submission { link note submittedBy submittedAt }
    }
  }
`;

// User reviews a SUBMITTED task; decision is FOR_REVISION or COMPLETED
// Only callable when status is currently SUBMITTED
const REVIEW_TASK = `
  mutation ReviewTask($taskId: ID!, $comment: String!, $decision: ReviewDecision!) {
    reviewTask(taskId: $taskId, comment: $comment, decision: $decision) {
      id status
      revisions { id comment status reviewedBy reviewedAt }
    }
  }
`;
```

**Task status flow to build the UI around:**

```
PENDING --submitTask--> SUBMITTED --reviewTask(FOR_REVISION)--> FOR_REVISION --submitTask--> SUBMITTED
                            |
                            +--reviewTask(COMPLETED)--> COMPLETED (terminal)
```
- `submitTask` fails if status is already `SUBMITTED` or `COMPLETED`.
- `reviewTask` fails unless status is currently `SUBMITTED`.
- Every `reviewTask` call appends to `revisions` — render that as the audit trail / comment thread on the task detail view.

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
