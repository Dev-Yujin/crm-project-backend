import { randomUUID, randomBytes } from "node:crypto";
import { pool } from "../config/supabase.js";
import { fetchUserGroupId } from "../utils/groups.js";

//Avoids visually-confusable characters (0/O, 1/I/L)
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const generateJoinCode = () => {
    const bytes = randomBytes(8);
    let code = "";
    for (const byte of bytes) {
        code += CODE_CHARS[byte % CODE_CHARS.length];
    }
    return code;
};

//Create a brand-new group for a user who doesn't have one yet, with a shareable join code
export const createGroup = async (userId) => {
    const existingGroupId = await fetchUserGroupId(userId);
    if (existingGroupId) {
        throw new Error("You already belong to a group");
    }

    const groupId = randomUUID();

    for (let attempt = 0; attempt < 5; attempt++) {
        const joinCode = generateJoinCode();
        const existing = await pool.query("SELECT 1 FROM groups WHERE join_code = $1", [joinCode]);

        if (existing.rows.length > 0) {
            continue;
        }

        await pool.query(
            'INSERT INTO groups ("groupId", "userId", join_code) VALUES ($1, $2, $3)',
            [groupId, userId, joinCode]
        );

        return { groupId, joinCode };
    }

    throw new Error("Could not generate a unique join code, please try again");
};

//Join an existing group using its join code
export const joinGroupByCode = async (userId, joinCode) => {
    const existingGroupId = await fetchUserGroupId(userId);
    if (existingGroupId) {
        throw new Error("You already belong to a group");
    }

    const result = await pool.query('SELECT "groupId" FROM groups WHERE join_code = $1 LIMIT 1', [joinCode]);

    if (result.rows.length === 0) {
        throw new Error("Invalid join code");
    }

    const { groupId } = result.rows[0];

    await pool.query(
        'INSERT INTO groups ("groupId", "userId", join_code) VALUES ($1, $2, $3)',
        [groupId, userId, joinCode]
    );

    return { groupId, joinCode };
};

//Fetch the current user's group + shareable join code
export const getMyGroup = async (userId) => {
    const result = await pool.query('SELECT "groupId", join_code FROM groups WHERE "userId" = $1 LIMIT 1', [userId]);

    if (result.rows.length === 0) {
        return null;
    }

    return { groupId: result.rows[0].groupId, joinCode: result.rows[0].join_code };
};
