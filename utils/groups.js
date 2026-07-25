import { pool } from "../config/supabase.js";

//Looks up which group a Supabase Auth user belongs to (manually assigned via the groups table)
export const fetchUserGroupId = async (userId) => {
    const result = await pool.query('SELECT "groupId" FROM groups WHERE "userId" = $1 LIMIT 1', [userId]);

    if (result.rows.length === 0) {
        return null;
    }

    return result.rows[0].groupId;
};

//Looks up which group a member belongs to
export const fetchMemberGroupId = async (memberUuid) => {
    const result = await pool.query('SELECT group_id FROM members WHERE uuid = $1', [memberUuid]);

    if (result.rows.length === 0) {
        throw new Error("Member not found");
    }

    return result.rows[0].group_id;
};
