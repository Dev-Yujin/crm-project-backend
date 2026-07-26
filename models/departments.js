import { getDatabase, ref, push, set, get, remove, update, serverTimestamp } from "firebase/database";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";
//Create a Department, and assign members (from the Postgres members table) to that Department — scoped per group

const db = getDatabase(app);

const mapMembers = (members) =>
    Object.entries(members ?? {}).map(([uuid, member]) => ({
        uuid,
        username: member.username,
        email: member.email,
        assignedAt: member.assignedAt,
    }));

//Add department function
export const addDepartment = async (name, groupId) => {
    try {
        const departmentsRef = ref(db, "departments");
        const newDepartmentRef = push(departmentsRef);
        await set(newDepartmentRef, {
            name,
            groupId,
            createdAt: serverTimestamp(),
        });

        return { id: newDepartmentRef.key, name, groupId };
    } catch (error) {
        console.error("Error adding department:", error);
        throw error;
    }
};

//Update a department's name (must belong to the caller's group)
export const updateDepartment = async (departmentId, name, groupId) => {
    try {
        const departmentRef = ref(db, `departments/${departmentId}`);
        const departmentSnapshot = await get(departmentRef);

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        await update(departmentRef, { name });
        return { id: departmentId, ...departmentSnapshot.val(), name, members: mapMembers(departmentSnapshot.val().members) };
    } catch (error) {
        console.error("Error updating department:", error);
        throw error;
    }
};

//Delete a department (must belong to the caller's group)
export const deleteDepartment = async (departmentId, groupId) => {
    try {
        const departmentRef = ref(db, `departments/${departmentId}`);
        const departmentSnapshot = await get(departmentRef);

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        await remove(departmentRef);
        return { id: departmentId, ...departmentSnapshot.val(), members: mapMembers(departmentSnapshot.val().members) };
    } catch (error) {
        console.error("Error deleting department:", error);
        throw error;
    }
};

//Add a member (by their members.uuid) to a department (both must belong to the caller's group)
export const addMemberToDepartment = async (departmentId, memberUuid, groupId) => {
    try {
        const departmentRef = ref(db, `departments/${departmentId}`);
        const departmentSnapshot = await get(departmentRef);

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        const memberQuery = "SELECT uuid, username, email FROM members WHERE uuid = $1 AND group_id = $2";
        const result = await pool.query(memberQuery, [memberUuid, groupId]);

        if (result.rows.length === 0) {
            throw new Error("Member not found");
        }

        const member = result.rows[0];
        const memberRef = ref(db, `departments/${departmentId}/members/${memberUuid}`);
        await set(memberRef, {
            username: member.username,
            email: member.email,
            assignedAt: serverTimestamp(),
        });

        return { departmentId, uuid: member.uuid, username: member.username, email: member.email };
    } catch (error) {
        console.error("Error adding member to department:", error);
        throw error;
    }
};

//Remove a member from a department (must belong to the caller's group)
export const removeMemberFromDepartment = async (departmentId, memberUuid, groupId) => {
    try {
        const departmentRef = ref(db, `departments/${departmentId}`);
        const departmentSnapshot = await get(departmentRef);

        if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
            throw new Error("Department not found");
        }

        const memberRef = ref(db, `departments/${departmentId}/members/${memberUuid}`);
        const memberSnapshot = await get(memberRef);

        if (!memberSnapshot.exists()) {
            throw new Error("Member is not assigned to this department");
        }

        await remove(memberRef);
        return true;
    } catch (error) {
        console.error("Error removing member from department:", error);
        throw error;
    }
};

//Fetch all departments belonging to a group, along with their assigned members
export const getAllDepartments = async (groupId) => {
    try {
        const departmentsSnapshot = await get(ref(db, "departments"));

        if (!departmentsSnapshot.exists()) {
            return [];
        }

        return Object.entries(departmentsSnapshot.val())
            .filter(([, department]) => department.groupId === groupId)
            .map(([id, department]) => ({
                id,
                name: department.name,
                groupId: department.groupId,
                createdAt: department.createdAt,
                members: mapMembers(department.members),
            }));
    } catch (error) {
        console.error("Error fetching departments:", error);
        throw error;
    }
};

//No-op if departmentId is null, otherwise throws if it's not in the caller's group's departments catalog
export const validateDepartmentExists = async (departmentId, groupId) => {
    if (departmentId == null) return;

    const departmentSnapshot = await get(ref(db, `departments/${departmentId}`));

    if (!departmentSnapshot.exists() || departmentSnapshot.val().groupId !== groupId) {
        throw new Error("Department not found");
    }
};
