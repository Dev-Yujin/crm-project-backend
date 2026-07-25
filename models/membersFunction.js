import { pool } from '../config/supabase.js';
import { hashPassword, comparePasswords, generateMemberToken, verifyMemberToken } from '../utils/authUser.js';
//Add, Delete, Edit Profile, and Login functions for CRM members — scoped per group

//Login function
export const loginMember = async (email, password) => {
    try {
        const query = 'SELECT uuid, username, email, password, group_id FROM members WHERE email = $1';
        const result = await pool.query(query, [email]);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        const { password: hashedPassword, ...member } = result.rows[0];
        const isPasswordValid = await comparePasswords(password, hashedPassword);

        if (!isPasswordValid) {
            throw new Error('Invalid password');
        }

        const token = generateMemberToken(member);
        return { member, token };
    } catch (error) {
        console.error('Error logging in member:', error);
        throw error;
    }
};

//Fetch the currently logged-in member from their token
export const fetchMemberFromToken = async (token) => {
    try {
        const decoded = verifyMemberToken(token);
        const query = 'SELECT uuid, username, email, group_id, created_at FROM members WHERE uuid = $1';
        const result = await pool.query(query, [decoded.uuid]);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        return result.rows[0];
    } catch (error) {
        console.error('Error fetching member from token:', error);
        throw error;
    }
};

//Fetch all members belonging to a group
export const getAllMembers = async (groupId) => {
    try {
        const query = 'SELECT uuid, username, email, group_id, created_at FROM members WHERE group_id = $1';
        const result = await pool.query(query, [groupId]);
        return result.rows;
    } catch (error) {
        console.error('Error fetching all members:', error);
        throw error;
    }
};

//Add member function — added to the caller's group
export const addMember = async (username, email, password, groupId) => {
    try {
        const hashedPassword = await hashPassword(password);
        const query = 'INSERT INTO members (username, email, password, group_id) VALUES ($1, $2, $3, $4) RETURNING uuid, username, email, group_id, created_at';
        const values = [username, email, hashedPassword, groupId];
        const result = await pool.query(query, values);
        return result.rows[0];
    } catch (error) {
        console.error('Error adding member:', error);
        throw error;
    }
};

//Delete member function (must belong to the caller's group)
export const deleteMember = async (uuid, groupId) => {
    try {
        const query = 'DELETE FROM members WHERE uuid = $1 AND group_id = $2 RETURNING uuid, username, email, group_id, created_at';
        const result = await pool.query(query, [uuid, groupId]);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        return result.rows[0];
    } catch (error) {
        console.error('Error deleting member:', error);
        throw error;
    }
};

//Edit member profile function (a member updates their own username/email/password)
export const editMemberProfile = async (uuid, { username, email, password } = {}) => {
    try {
        const fields = [];
        const values = [];
        let i = 1;

        if (username !== undefined) {
            fields.push(`username = $${i++}`);
            values.push(username);
        }
        if (email !== undefined) {
            fields.push(`email = $${i++}`);
            values.push(email);
        }
        if (password !== undefined) {
            fields.push(`password = $${i++}`);
            values.push(await hashPassword(password));
        }

        if (fields.length === 0) {
            throw new Error('No fields provided to update');
        }

        values.push(uuid);
        const query = `UPDATE members SET ${fields.join(', ')} WHERE uuid = $${i} RETURNING uuid, username, email, group_id, created_at`;
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        return result.rows[0];
    } catch (error) {
        console.error('Error editing member profile:', error);
        throw error;
    }
};
