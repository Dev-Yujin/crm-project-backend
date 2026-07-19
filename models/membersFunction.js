import { pool } from '../config/supabase.js';
import { hashPassword, comparePasswords, generateMemberToken, verifyMemberToken } from '../utils/authUser.js';
//Add, Delete, Edit Profile, and Login functions for CRM members

//Login function
export const loginMember = async (email, password) => {
    try {
        const query = 'SELECT uuid, username, email, password FROM members WHERE email = $1';
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
        const query = 'SELECT uuid, username, email, created_at FROM members WHERE uuid = $1';
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

//Fetch all members
export const getAllMembers = async () => {
    try {
        const query = 'SELECT uuid, username, email, created_at FROM members';
        const result = await pool.query(query);
        return result.rows;
    } catch (error) {
        console.error('Error fetching all members:', error);
        throw error;
    }
};

//Add member function
export const addMember = async (username, email, password) => {
    try {
        const hashedPassword = await hashPassword(password);
        const query = 'INSERT INTO members (username, email, password) VALUES ($1, $2, $3) RETURNING uuid, username, email, created_at';
        const values = [username, email, hashedPassword];
        const result = await pool.query(query, values);
        return result.rows[0];
    } catch (error) {
        console.error('Error adding member:', error);
        throw error;
    }
};

//Delete member function
export const deleteMember = async (uuid) => {
    try {
        const query = 'DELETE FROM members WHERE uuid = $1 RETURNING uuid, username, email, created_at';
        const result = await pool.query(query, [uuid]);

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
        const query = `UPDATE members SET ${fields.join(', ')} WHERE uuid = $${i} RETURNING uuid, username, email, created_at`;
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
