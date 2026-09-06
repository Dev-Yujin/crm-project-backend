import { getDatabase } from "firebase-admin/database";
import { app } from "../config/firebase.js";
//User-defined fields on Task/Client/RecurringTask records — each entity type has its own
//independent catalog of field definitions, scoped per group. Field VALUES live directly on
//the owning record (see toStoredCustomFields/fromStoredCustomFields below), not here — this
//file only owns the field DEFINITIONS plus the shared validate/convert helpers every
//Task/Client/RecurringTask model function reuses.

const db = getDatabase(app);

export const CUSTOM_FIELD_ENTITY_TYPES = {
    TASK: "TASK",
    CLIENT: "CLIENT",
    RECURRING_TASK: "RECURRING_TASK",
};

export const CUSTOM_FIELD_TYPES = {
    TEXT: "TEXT",
    NUMBER: "NUMBER",
    DATE: "DATE",
    DROPDOWN: "DROPDOWN",
};

//Fetch all custom field definitions for one entity type in a group
export const getFieldDefinitions = async (entityType, groupId) => {
    try {
        const snapshot = await db.ref("customFieldDefinitions").once("value");
        const data = snapshot.val();
        const definitions = data ? Object.entries(data).map(([id, def]) => ({ id, ...def })) : [];
        return definitions.filter((def) => def.entityType === entityType && def.groupId === groupId);
    } catch (error) {
        console.error("Error fetching custom field definitions:", error);
        throw error;
    }
};

//Add a new custom field definition. type is fixed for the definition's lifetime (see
//updateFieldDefinition) — changing TEXT->NUMBER on a field with existing string values
//would corrupt them, so that's a delete+recreate instead of an in-place type change.
export const addFieldDefinition = async ({ entityType, name, type, options }, groupId) => {
    try {
        if (type === CUSTOM_FIELD_TYPES.DROPDOWN && (!options || options.length === 0)) {
            throw new Error("Dropdown fields require at least one option");
        }

        const definitionsRef = db.ref("customFieldDefinitions");
        const newRef = definitionsRef.push();
        const definition = {
            groupId,
            entityType,
            name,
            type,
            options: type === CUSTOM_FIELD_TYPES.DROPDOWN ? options : null,
            createdAt: Date.now(),
        };
        await newRef.set(definition);
        return { id: newRef.key, ...definition };
    } catch (error) {
        console.error("Error adding custom field definition:", error);
        throw error;
    }
};

//Update a definition's name and/or dropdown options — never its type or entityType (must
//belong to the caller's group)
export const updateFieldDefinition = async (fieldId, { name, options }, groupId) => {
    try {
        const ref = db.ref(`customFieldDefinitions/${fieldId}`);
        const snapshot = await ref.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Custom field not found");
        }

        const existing = snapshot.val();

        if (existing.type === CUSTOM_FIELD_TYPES.DROPDOWN && options !== undefined && options.length === 0) {
            throw new Error("Dropdown fields require at least one option");
        }

        const updates = {
            ...(name !== undefined && { name }),
            ...(options !== undefined && { options }),
        };

        await ref.update(updates);
        return { id: fieldId, ...existing, ...updates };
    } catch (error) {
        console.error("Error updating custom field definition:", error);
        throw error;
    }
};

//Delete a definition (must belong to the caller's group). Never touches stored values on
//any Task/Client/RecurringTask record — those become inert (not rendered, not validated
//against a deleted definition) but are never force-cleaned. No cascade, by design.
export const deleteFieldDefinition = async (fieldId, groupId) => {
    try {
        const ref = db.ref(`customFieldDefinitions/${fieldId}`);
        const snapshot = await ref.once("value");

        if (!snapshot.exists() || snapshot.val().groupId !== groupId) {
            throw new Error("Custom field not found");
        }

        await ref.remove();
        return true;
    } catch (error) {
        console.error("Error deleting custom field definition:", error);
        throw error;
    }
};

//No-op if values is null/undefined (omitted = no custom fields submitted on this call,
//matching the omitted-means-unchanged convention every other optional field in this
//codebase already uses). Otherwise validates every {fieldId, value} pair against that
//entity type's field definitions before any write happens.
export const validateCustomFieldValues = async (values, entityType, groupId) => {
    if (values == null) {
        return;
    }

    const definitions = await getFieldDefinitions(entityType, groupId);
    const byId = new Map(definitions.map((def) => [def.id, def]));

    for (const { fieldId, value } of values) {
        const definition = byId.get(fieldId);

        if (!definition) {
            throw new Error(`Custom field not found: ${fieldId}`);
        }

        if (definition.type === CUSTOM_FIELD_TYPES.DROPDOWN && !(definition.options ?? []).includes(value)) {
            throw new Error(`${definition.name} must be one of: ${(definition.options ?? []).join(", ")}`);
        }

        if (definition.type === CUSTOM_FIELD_TYPES.NUMBER && !Number.isFinite(Number(value))) {
            throw new Error(`${definition.name} must be a number`);
        }

        if (definition.type === CUSTOM_FIELD_TYPES.DATE && Number.isNaN(new Date(value).getTime())) {
            throw new Error(`${definition.name} must be a valid date`);
        }
    }
};

//Converts the GraphQL array shape ({fieldId, value}[]) into the stored object shape
//({[fieldId]: value}) written onto a Task/Client/RecurringTask record. undefined and null
//are deliberately NOT collapsed together: undefined means "omitted, leave untouched" and
//passes through as undefined for callers that guard on `!== undefined` before spreading;
//explicit null means "clear every custom field value" and must stay null so Firebase's
//.update() deletes the key — passing undefined into .update() throws, it does not delete.
export const toStoredCustomFields = (values) => {
    if (values === undefined) {
        return undefined;
    }
    if (values === null) {
        return null;
    }
    return Object.fromEntries(values.map(({ fieldId, value }) => [fieldId, value]));
};

//Converts a record's stored object shape back into the GraphQL array shape — used by
//every Task/Client/RecurringTask resolver's mapping function. A record with no
//customFields key at all (every record that existed before this feature) maps to [].
export const fromStoredCustomFields = (stored) => {
    return Object.entries(stored ?? {}).map(([fieldId, value]) => ({ fieldId, value }));
};
