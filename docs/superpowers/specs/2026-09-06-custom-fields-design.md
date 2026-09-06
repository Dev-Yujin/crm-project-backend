# Custom fields on Task, Client, and RecurringTask

## Problem

Every record shape in this app (Task, Client, RecurringTask) is fixed in both the GraphQL schema and the Firebase RTDB record shape. An admin cannot add their own field (e.g. "Referral source" on a Client, "PO number" on a Task) without a code change. This is a real competitive gap against Zoho/Monday/Trello, all of which let a non-technical admin add fields with no code, and it becomes a recurring support/sales-blocker conversation the moment a real customer's workflow doesn't match the fixed schema exactly.

## Goals

- An admin can define custom fields — Text, Number, Date, or Dropdown (single choice) — independently for Tasks, Clients, and RecurringTask templates.
- Existing Task/Client/RecurringTask records are completely unaffected: no backfill, no migration, no risk of data loss or corruption.
- A RecurringTask template's custom field values carry over to every Task instance the scheduler generates from it, matching how assignedMembers/department/client already flow from template to instance.
- Deleting a field definition never touches already-stored values on any record — it only stops the field from being editable/visible going forward.

## Non-goals

- No support for changing a field's type after creation (e.g. TEXT → NUMBER) — delete and recreate instead. Changing type in place risks corrupting existing string values that no longer parse as the new type.
- No cross-entity-type field sharing — a field defined for Client cannot be used on Task or RecurringTask. Each entity type has its own independent catalog of field definitions.
- No multi-select, checkbox, rich-text, or file-upload custom field types — only Text, Number, Date, Dropdown, per this pass's explicit scope.
- No bulk-edit or CSV-import of custom field values — out of scope, not requested.

## Architecture

**Backend — new Firebase RTDB collection `customFieldDefinitions`** (flat top-level collection, same pattern as `taskStatuses`/`departments`/`services`):

```js
customFieldDefinitions/{fieldId} = {
  groupId: string,
  entityType: 'TASK' | 'CLIENT' | 'RECURRING_TASK',
  name: string,
  type: 'TEXT' | 'NUMBER' | 'DATE' | 'DROPDOWN',
  options: string[] | null,   // only set (and only meaningful) when type === 'DROPDOWN'
  createdAt: number,
}
```

**Field values live directly on each record** as a new optional key — `customFields: { [fieldId]: string }` — added to `tasks/{id}`, `clients/{id}`, and `recurringTasks/{id}` records. Every value is stored as a string regardless of declared type (Number/Date included); the field definition's `type` is what tells the frontend how to parse/format/render it. This is purely additive: an existing record simply has no `customFields` key, and every read site treats a missing key identically to `{}` (`record.customFields ?? {}`). No existing record is ever migrated, touched, or reshaped by this feature.

**Backend — new model file `models/customFields.js`** (single responsibility: define, validate, and read custom field definitions and values):

- `getFieldDefinitions(entityType, groupId)` — reads `customFieldDefinitions`, filtered by `entityType` and `groupId` (same `orderByChild`/filter pattern already used by `getAllTasksForGroupIndexed` and friends).
- `addFieldDefinition({ entityType, name, type, options }, groupId)` — validates `options` is a non-empty array when `type === 'DROPDOWN'` and is `null`/omitted otherwise; writes a new `customFieldDefinitions` entry.
- `updateFieldDefinition(fieldId, { name, options }, groupId)` — `type` is intentionally not an accepted argument here (see Non-goals). Rejects if the definition's `groupId` doesn't match the caller's (same not-found-shaped error every other model in this codebase uses for a cross-group id).
- `deleteFieldDefinition(fieldId, groupId)` — removes the definition only. Never touches `customFields` values on any Task/Client/RecurringTask record.
- `validateCustomFieldValues(values, entityType, groupId)` — given an array of `{ fieldId, value }` (or `null`/omitted, meaning "no custom fields submitted"), loads that entity type's field definitions and: rejects any `fieldId` not found among them; for `DROPDOWN` fields, rejects a `value` not in that field's `options`; for `NUMBER` fields, rejects a `value` that doesn't parse via `Number.isFinite(Number(value))`; for `DATE` fields, rejects a `value` that isn't parseable by `parseWhen` (the same date-parsing helper the frontend already uses, mirrored on the backend or reused if already isomorphic — implementer's call, matching existing conventions). Returns the values unchanged (still strings) on success — this function only validates, callers convert the array to the stored `{ [fieldId]: value }` object shape themselves. Skipped entirely (no-op) when `values` is `null`/omitted, matching the omitted-means-unchanged convention used everywhere else in this codebase.

**Backend — `models/task.js`, `models/clients.js`, `models/recurringTasks.js`:** `addTask`/`editTask`, `addClient`/`editClient`, `addRecurringTask`/`editRecurringTask` each gain an optional `customFields` parameter (array of `{ fieldId, value }`, or omitted). When provided: call `validateCustomFieldValues(customFields, entityType, groupId)`, then convert to the stored object shape (`Object.fromEntries(customFields.map(v => [v.fieldId, v.value]))`) and include it in the Firebase write. When omitted: the existing record's `customFields` (if any) is left untouched, exactly like every other optional field in `editTask`/`editRecurringTask` today.

**Backend — `runDueRecurringTasks` (`models/recurringTasks.js`):** the `addTask(...)` call already passed from a template to its generated instance gains one more argument — the template's own `customFields`, converted from its stored object shape back into the `{ fieldId, value }` array shape `addTask` expects. This is the "carry over to generated instances" behavior — no different in kind from how `assignedMembers`/`departmentId` already flow through this exact call.

**GraphQL schema (new, in a new `typedefs/customFieldTypeDefs.js`):**

```graphql
enum CustomFieldEntityType { TASK, CLIENT, RECURRING_TASK }
enum CustomFieldType { TEXT, NUMBER, DATE, DROPDOWN }

type CustomFieldDefinition {
  id: ID!
  entityType: CustomFieldEntityType!
  name: String!
  type: CustomFieldType!
  options: [String!]
  groupId: ID!
}

type CustomFieldValue {
  fieldId: ID!
  value: String!
}

input CustomFieldValueInput {
  fieldId: ID!
  value: String!
}

type Query {
  customFieldDefinitions(entityType: CustomFieldEntityType!): [CustomFieldDefinition!]!
}

type Mutation {
  addCustomFieldDefinition(entityType: CustomFieldEntityType!, name: String!, type: CustomFieldType!, options: [String!]): CustomFieldDefinition!
  updateCustomFieldDefinition(fieldId: ID!, name: String, options: [String!]): CustomFieldDefinition!
  deleteCustomFieldDefinition(fieldId: ID!): Boolean!
}
```

`Task`, `Client`, and `RecurringTask` types each gain `customFields: [CustomFieldValue!]!` (defaults to `[]` when the record has no stored values — same `?? []` pattern `assignedMembers` already uses on `Task`). `addTask`/`editTask`, `addClient`/`editClient`, `addRecurringTask`/`editRecurringTask` mutations each gain an optional `customFields: [CustomFieldValueInput!]` argument.

**Resolvers:** new `resolvers/customFieldResolvers.js` (query + 3 mutations, all `requireGroup`-gated, admin-only — matching every other definition-management resolver in this codebase, e.g. `taskStatusResolvers`/`departmentResolvers`). Existing Task/Client/RecurringTask resolvers' mapping functions gain `customFields: Object.entries(record.customFields ?? {}).map(([fieldId, value]) => ({ fieldId, value }))`.

**Frontend:**

- New admin settings page `src/pages/CustomFields.tsx`, following the exact structure of `TaskStatuses.tsx`/`Departments.tsx`: a type filter/tab (Task / Client / RecurringTask), a list of existing field definitions per type, add/edit/delete actions. The add/edit form: name input, type select (locked after creation, matching the backend restriction), and an options-list editor (add/remove/reorder string options) that only appears when type is Dropdown.
- New route `/app/custom-fields` registered in `App.tsx`, alongside the other settings-style routes (`task-statuses`, `departments`, `services`).
- `TaskFormModal`, client add/edit form, and `RecurringTaskFormModal` each gain a "Custom fields" section: for each field definition matching that entity type, render the appropriate input (text/number/date input, or a `Select` for dropdown) bound to that record's `customFields` value for that `fieldId`. Renders nothing if no field definitions exist for that entity type yet — the section simply doesn't appear, not an empty placeholder.
- `TaskDetailModal` and the client detail view render custom field values read-only, alongside existing fields, again only when at least one is defined for that entity type.
- New `src/hooks/useCustomFieldDefinitions.ts` (entity-type-scoped, mirroring the existing `useTaskStatuses`/`useDepartments` hooks) fetches and caches field definitions for a given entity type.

## Error Handling

| Scenario | Behavior |
|---|---|
| `addCustomFieldDefinition` with `type: DROPDOWN` and no/empty `options` | Rejected: `"Dropdown fields require at least one option"` |
| `addCustomFieldDefinition` with `type` other than `DROPDOWN` and non-null `options` | `options` silently ignored (not an error) — matches this codebase's general tolerance for harmless extra input over pedantic rejection, but implementer may instead choose to reject if that reads cleaner; not load-bearing either way |
| `updateCustomFieldDefinition` attempts to change `type` (not an accepted argument at all) | N/A at the GraphQL layer — the argument doesn't exist, so this is structurally impossible, not a runtime error case |
| `editTask`/`editClient`/`editRecurringTask` called with a `customFields` entry whose `fieldId` doesn't exist for that entity type/group | Rejected: `"Custom field not found: <fieldId>"` |
| ...with a `DROPDOWN` field's value not among its declared `options` | Rejected: `"<field name> must be one of: <options list>"` |
| ...with a `NUMBER` field's value that isn't numeric | Rejected: `"<field name> must be a number"` |
| ...with a `DATE` field's value that isn't a parseable date | Rejected: `"<field name> must be a valid date"` |
| `customFields` argument omitted entirely on an edit | No-op — existing stored values (if any) are left completely untouched, matching every other optional field |
| `deleteCustomFieldDefinition` on a field with existing values stored on live records | Succeeds unconditionally. Those records keep their stored `customFields[fieldId]` value forever (or until independently edited) — it's just never rendered or validated again. No cascade, no cleanup pass, by design |
| A RecurringTask template's `customFields` at the moment the scheduler fires | Copied as-is into the generated Task instance's own `customFields`, exactly once, at generation time — editing the template's custom field values afterward does not retroactively change already-generated instances (same "changes apply going forward only" rule already established for `recurrence` edits) |

## Testing

- `models/customFields.js` (new test file): field definition CRUD (add/update/delete, dropdown-requires-options validation), `validateCustomFieldValues` for each of the four types (valid + invalid cases per type), and confirms a missing/omitted `customFields` argument is a true no-op.
- `models/task.js`/`models/clients.js`/`models/recurringTasks.js` tests: `addTask`/`editTask` etc. accept and store `customFields` correctly; omitting it leaves existing values untouched; an invalid value is rejected before any write occurs.
- `models/recurringTasks.js` `runDueRecurringTasks` test: a template with `customFields` set generates an instance carrying the same values.
- Frontend: no test suite — verify via `tsc --noEmit` + `oxlint`, plus live/manual verification: define a Text/Number/Date/Dropdown field on each entity type, set values on a new Task/Client/RecurringTask, confirm existing (pre-feature) records still open and edit normally with no custom-fields section forcing any value, confirm a RecurringTask's custom field values appear on its next scheduler-generated instance, confirm deleting a field definition doesn't error out or blank the value on a record that still has it stored.
