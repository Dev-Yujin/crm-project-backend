import { pool } from "../config/supabase.js";

//Group creation is now automatic: a Postgres trigger (`on_auth_user_created_group` on auth.users,
//function `handle_new_user_group`) inserts a fresh group + join code for every new Supabase Auth
//user, regardless of how they signed up (email/password via registerUser, Google OAuth direct from
//the frontend, etc.) — this file only has to handle joining/reading a group, never creating one.

//Join an existing group using its join code — moves the user's own row to that group
//(every user already has exactly one row, auto-created at signup)
export const joinGroupByCode = async (userId, joinCode) => {
    const result = await pool.query('SELECT "groupId" FROM groups WHERE join_code = $1 LIMIT 1', [joinCode]);

    if (result.rows.length === 0) {
        throw new Error("Invalid join code");
    }

    const { groupId } = result.rows[0];

    const updateResult = await pool.query(
        'UPDATE groups SET "groupId" = $1, join_code = $2 WHERE "userId" = $3 RETURNING "groupId", join_code',
        [groupId, joinCode, userId]
    );

    if (updateResult.rows.length === 0) {
        throw new Error("User not found");
    }

    return { groupId: updateResult.rows[0].groupId, joinCode: updateResult.rows[0].join_code };
};

//Fetch every user (Supabase Auth account) that belongs to a given group
export const getGroupUsers = async (groupId) => {
    const result = await pool.query(
        `SELECT u.id, u.email, u.raw_user_meta_data->>'name' AS name, u.created_at
         FROM groups g
         JOIN auth.users u ON u.id = g."userId"
         WHERE g."groupId" = $1
         ORDER BY u.created_at`,
        [groupId]
    );

    return result.rows;
};

//Fetch the current user's group + shareable join code
export const getMyGroup = async (userId) => {
    const result = await pool.query('SELECT "groupId", join_code FROM groups WHERE "userId" = $1 LIMIT 1', [userId]);

    if (result.rows.length === 0) {
        return null;
    }

    return { groupId: result.rows[0].groupId, joinCode: result.rows[0].join_code };
};
