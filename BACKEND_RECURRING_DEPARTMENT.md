# Backend Work Required — Recurring Task Department (+ one open question)

Two items on `RecurringTask`. The first is a confirmed gap; the second is a question
only you can answer.

| # | Item | Status |
|---|---|---|
| 1 | `RecurringTask.departmentId` | **Missing — confirmed** |
| 2 | Does the scheduler copy `assignedUsers` onto generated tasks? | **Unverified — please confirm** |

> **First, to be clear about blame:** the bug that prompted this — recurring tasks not
> appearing in an admin's My Tasks — was a **frontend** fault. `RecurringTaskFormModal`
> was never wired for `assignedUsers` when admin assignment was added. That is fixed.
> The two items below are separate, genuine backend gaps found while investigating.

---

## 1. `RecurringTask.departmentId` — confirmed missing

```
{ recurringTasks { id departmentId } }
  -> Cannot query field "departmentId" on type "RecurringTask"

addRecurringTask(… departmentId: "x")
  -> Unknown argument "departmentId" on field "Mutation.addRecurringTask"
```

### Why it matters

`Task.departmentId` exists and the task form makes it **required**. A template has
nowhere to store one, so every task the scheduler generates is born without a
department. The live data shows exactly that:

| | has `departmentId` |
|---|---|
| Manually created tasks | **13 / 13** (100%) |
| Scheduler-generated tasks | **2 / 30** (7%) |

So recurring work is effectively invisible to any department-based filtering or
reporting, while manual work is fully covered. The two outliers are likely tasks edited
after generation.

### Schema

```graphql
type RecurringTask {
  # …existing fields unchanged…

  "Department this template's generated tasks belong to. Same catalog and same
   informational semantics as Task.departmentId."
  departmentId: ID
}

type Mutation {
  addRecurringTask(…existing args…, departmentId: ID): RecurringTask
}
```

Nullable, matching `Task.departmentId`. Existing templates read as `null`.

### Resolver notes

- Validate `departmentId` against the **caller's own group**, same as `addTask` already
  does. Same non-cascading caveat applies: deleting a department in use leaves a
  dangling id.
- **The scheduler must copy it onto each generated `Task`.** That is the entire point —
  storing it on the template and not propagating it changes nothing.
- If you add an `editRecurringTask` later, the partial-update rule from
  `LIVE_LINK_SOURCE_INTEGRATION.md` applies: omitted leaves it alone, `null` clears it.

---

## 2. Open question: does generation copy `assignedUsers`?

`RECURRING_TASKS_INTEGRATION.md` says the hourly scheduler generates instances "via the
same `addTask` logic used elsewhere". Whether `assignedUsers` rides along is not
documented, and the live data can't settle it:

- 0 of 7 templates carry `assignedUsers`, so there is nothing to inherit from yet.
- Exactly 1 generated task has `assignedUsers` — but it sits in group `a12a824d`, which
  isn't one of the five real groups, so it looks like a test artifact rather than
  evidence.

**Why it matters:** if the scheduler drops `assignedUsers`, then a template assigned to
an admin will generate tasks that never appear in that admin's My Tasks — the exact
symptom that started this investigation, reappearing one scheduler tick later.

Please confirm the generator copies **both** `assignedUsers` and (once added)
`departmentId`. If it builds its generated task from an explicit field list, both
almost certainly need adding to it.

---

## 3. Frontend status

Already implemented and merged, gated behind `RECURRING_TASK_DEPARTMENT` in
`src/lib/featureFlags.ts` (currently `false`). Flip it when this ships — the flag exists
because naming an unknown argument fails the *whole* GraphQL document, which would
break recurring task creation outright.

Verify with:

```bash
curl -s -X POST "$VITE_GRAPHQL_URL" -H 'Content-Type: application/json' \
  -d '{"query":"{ recurringTasks { id departmentId } }"}'
```

`UNAUTHENTICATED` = shipped. `Cannot query field` = not yet.

---

## 4. Acceptance checklist

- [ ] `addRecurringTask` accepts `departmentId` and returns it
- [ ] `recurringTasks` returns `departmentId` (`null` on existing templates)
- [ ] A department id from another group is rejected
- [ ] **A generated task carries the template's `departmentId`**
- [ ] **A generated task carries the template's `assignedUsers`** (item 2)
- [ ] Existing templates still generate tasks without erroring
