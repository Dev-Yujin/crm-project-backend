# Recurring Tasks — Frontend Integration Guide

This is a separate doc from [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md), which still covers setup, auth, and the `graphqlRequest` helper — use that as the base. This doc only covers the recurring task feature layered on top of the existing one-off `Task` system.

## How it works

A **RecurringTask** is a template: client, task details, service, assigned members, and a `recurrence` (`DAILY` / `WEEKLY` / `MONTHLY`). It does **not** show up in task lists itself — instead, the backend has an hourly scheduler that checks every active template and, when one is due, generates a normal `Task` instance for it (via the same `addTask` logic used elsewhere). That generated task is a plain `Task` — same free-form `statusId` (from the `taskStatuses` catalog), same `submitTask`/`reviewTask` behavior already documented in `FRONTEND_INTEGRATION.md` — nothing new to learn there.

```
RecurringTask template (DAILY/WEEKLY/MONTHLY)
        │
        │  scheduler tick (hourly, generates one instance when due)
        ▼
   Task instance  ──►  tasks / tasksForMember queries, submitTask, reviewTask
   (recurringTaskId set, links back to the template)
```

Key behaviors to know before building the UI:
- **Creating a template immediately generates its first task instance** — you don't need a separate "create the first one manually" step.
- **The scheduler ticks hourly.** A `DAILY` template due at 2:00 PM might generate its instance anytime between 2:00–3:00 PM, not exactly on the minute.
- **Pausing a template stops new instances**, but doesn't touch ones already generated.
- **Deleting a template** stops future generation but does **not** delete previously generated `Task` instances — they stay as normal tasks.
- **Every `Task` now has a `recurringTaskId` field** (nullable). Use it to badge/filter "this came from a recurring template" in the regular task list, and to link back to `RECURRING_TASK` detail from a task.
- If the server was down when a template was due, the next tick generates exactly **one** catch-up instance (not one per missed cycle) and fast-forwards the schedule — so don't expect a backlog of instances after downtime.

## Auth

Everything here is a **user**-only feature (same as `addTask`/`deleteTask`/`reviewTask`) — members don't manage recurring templates. Send `Authorization: Bearer <session.access_token>` via `graphqlRequest` from §3 of the main doc.

| Operation | Type | Auth required |
|---|---|---|
| `recurringTasks` | Query | **user** |
| `addRecurringTask` | Mutation | **user** |
| `pauseRecurringTask` / `resumeRecurringTask` | Mutation | **user** |
| `deleteRecurringTask` | Mutation | **user** |

## TypeScript types

```ts
export type Recurrence = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface RecurringTask {
  id: string;
  clientId: string;
  clientName: string;
  taskName: string;
  taskDescription: string;
  serviceId: string;
  assignedMembers: string[]; // member uuids
  priority: TaskPriority; // from FRONTEND_INTEGRATION.md
  recurrence: Recurrence;
  createdBy: string | null; // user id
  active: boolean;
  lastRunAt: string | null; // when the scheduler last generated an instance
  nextRunAt: string | null; // when it's next due
}
```

`Task` also gains one field on top of what's already documented:
```ts
export interface Task {
  // ...all fields already in FRONTEND_INTEGRATION.md...
  recurringTaskId: string | null; // set if this task was auto-generated from a template
}
```

## Operations

```ts
const GET_RECURRING_TASKS = `
  query GetRecurringTasks {
    recurringTasks {
      id clientId clientName taskName taskDescription serviceId
      assignedMembers priority recurrence createdBy active lastRunAt nextRunAt
    }
  }
`;

const ADD_RECURRING_TASK = `
  mutation AddRecurringTask(
    $clientId: ID!
    $clientName: String!
    $taskName: String!
    $taskDescription: String!
    $serviceId: ID!
    $assignedMembers: [ID!]!
    $recurrence: Recurrence!
    $priority: TaskPriority
  ) {
    addRecurringTask(
      clientId: $clientId
      clientName: $clientName
      taskName: $taskName
      taskDescription: $taskDescription
      serviceId: $serviceId
      assignedMembers: $assignedMembers
      recurrence: $recurrence
      priority: $priority
    ) {
      id taskName recurrence active nextRunAt
    }
  }
`;
// priority defaults to MEDIUM if omitted. serviceId must be one of the
// selected client's servicesAvailed — same constraint as addTask.
// This call also generates the first Task instance immediately; no follow-up call needed.

const PAUSE_RECURRING_TASK = `
  mutation PauseRecurringTask($recurringTaskId: ID!) {
    pauseRecurringTask(recurringTaskId: $recurringTaskId) { id active }
  }
`;

const RESUME_RECURRING_TASK = `
  mutation ResumeRecurringTask($recurringTaskId: ID!) {
    resumeRecurringTask(recurringTaskId: $recurringTaskId) { id active }
  }
`;

const DELETE_RECURRING_TASK = `
  mutation DeleteRecurringTask($recurringTaskId: ID!) {
    deleteRecurringTask(recurringTaskId: $recurringTaskId)
  }
`;
```

## Suggested UI

- A **Recurring Tasks** admin screen (separate from the regular task board): list from `GET_RECURRING_TASKS`, showing `recurrence`, `active`, and `nextRunAt` ("Next run: in ~3 hours") so users know when the next instance will appear. Pause/resume/delete actions per row.
- On the regular task board, tasks with a non-null `recurringTaskId` can show a small recurring icon/badge, since visually they're otherwise identical to one-off tasks and go through the same `submitTask`/`reviewTask` flow.
