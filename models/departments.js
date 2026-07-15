import { getDatabase, ref, push, set, get, remove, serverTimestamp } from "firebase/database";
import { app } from "../config/firebase.js";
import { pool } from "../config/supabase.js";
//Create a Department, and assign members (from the Postgres members table) to that Department

const db = getDatabase(app);

//Add department function
export const addDepartment = async (name) => {
    try {
        const departmentsRef = ref(db, "departments");
        const newDepartmentRef = push(departmentsRef);
        await set(newDepartmentRef, {
            name,
            createdAt: serverTimestamp(),
        });

        return { id: newDepartmentRef.key, name };
    } catch (error) {
        console.error("Error adding department:", error);
        throw error;
    }
};

//Add a member (by their members.uuid) to a department
export const addMemberToDepartment = async (departmentId, memberUuid) => {
    try {
        const departmentRef = ref(db, `departments/${departmentId}`);
        const departmentSnapshot = await get(departmentRef);

        if (!departmentSnapshot.exists()) {
            throw new Error("Department not found");
        }

        const memberQuery = "SELECT uuid, username, email FROM members WHERE uuid = $1";
        const result = await pool.query(memberQuery, [memberUuid]);

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

//Remove a member from a department
export const removeMemberFromDepartment = async (departmentId, memberUuid) => {
    try {
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

//Fetch all departments, along with their assigned members
export const getAllDepartments = async () => {
    try {
        const departmentsSnapshot = await get(ref(db, "departments"));

        if (!departmentsSnapshot.exists()) {
            return [];
        }

        return Object.entries(departmentsSnapshot.val()).map(([id, department]) => ({
            id,
            name: department.name,
            createdAt: department.createdAt,
            members: Object.entries(department.members ?? {}).map(([uuid, member]) => ({
                uuid,
                username: member.username,
                email: member.email,
                assignedAt: member.assignedAt,
            })),
        }));
    } catch (error) {
        console.error("Error fetching departments:", error);
        throw error;
    }
};
