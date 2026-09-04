import { pool } from '../config/supabase.js';
import { hashPassword, comparePasswords, generateMemberToken, verifyMemberToken } from '../utils/authUser.js';
import { checkRateLimit } from '../utils/rateLimit.js';
import { GraphQLError } from 'graphql';
import { validateMembersExist } from './task.js';
import { countMemberAssignments, reassignMemberAssignments } from './memberAssignments.js';
//Add, Delete, Edit Profile, and Login functions for CRM members — scoped per group

//Login function
export const loginMember = async (email, password, ip) => {
    checkRateLimit(`loginMember:${email.toLowerCase()}`);
    // Skip the IP-keyed check entirely when ip is falsy (e.g. req.ip can legitimately be
    // undefined on aborted/destroyed connections). Without this guard, a missing IP would
    // interpolate to the literal key "loginMember-ip:undefined", collapsing every member
    // across every group into one shared bucket — 20 such requests system-wide would lock
    // out login for everyone. The per-email check above remains the backstop either way.
    if (ip) {
        checkRateLimit(`loginMember-ip:${ip}`, { max: 20, windowMs: 15 * 60 * 1000 });
    }

    try {
        const query = 'SELECT uuid, username, email, password, group_id, token_version, avatar_base64 FROM members WHERE email = $1';
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
        const { token_version, ...memberWithoutTokenVersion } = member;
        return { member: memberWithoutTokenVersion, token };
    } catch (error) {
        console.error('Error logging in member:', error);
        throw error;
    }
};

//Verify a member's bearer token: checks the signature/expiry AND that its embedded
//tokenVersion still matches the row (bumping token_version invalidates every outstanding
//token for that member — see revokeMemberSessions).
export const fetchMemberFromToken = async (token) => {
    try {
        const decoded = verifyMemberToken(token);
        const query = 'SELECT uuid, username, email, group_id, created_at, token_version FROM members WHERE uuid = $1';
        const result = await pool.query(query, [decoded.uuid]);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        const member = result.rows[0];

        if ((decoded.tokenVersion ?? 0) !== member.token_version) {
            throw new Error('Token has been revoked');
        }

        const { token_version, ...memberWithoutTokenVersion } = member;
        return memberWithoutTokenVersion;
    } catch (error) {
        console.error('Error fetching member from token:', error);
        throw error;
    }
};

//Bump a member's token_version, invalidating every outstanding token for them. Caller must
//verify group ownership before calling this (see revokeMemberSessions resolver).
export const revokeMemberSessions = async (uuid, groupId) => {
    try {
        const query = 'UPDATE members SET token_version = token_version + 1 WHERE uuid = $1 AND group_id = $2 RETURNING uuid';
        const result = await pool.query(query, [uuid, groupId]);

        if (result.rows.length === 0) {
            throw new Error('Member not found');
        }

        return true;
    } catch (error) {
        console.error('Error revoking member sessions:', error);
        throw error;
    }
};

//Fetch all members belonging to a group
export const getAllMembers = async (groupId) => {
    try {
        const query = 'SELECT uuid, username, email, group_id, created_at, avatar_base64 FROM members WHERE group_id = $1';
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

//Delete member function (must belong to the caller's group). If the member still has
//task/recurring-task assignments, the caller must either supply reassignTo (an existing
//member in the same group to transfer those assignments to first) or the delete is
//refused — deleteMember never silently leaves a dangling assignedMembers reference behind.
export const deleteMember = async (uuid, groupId, reassignTo = null) => {
    try {
        if (reassignTo != null) {
            if (reassignTo === uuid) {
                throw new Error('Cannot reassign to the member being deleted');
            }
            await validateMembersExist([reassignTo], groupId);
            await reassignMemberAssignments(uuid, reassignTo, groupId);
        } else {
            const { taskCount, recurringTaskCount } = await countMemberAssignments(uuid, groupId);
            if (taskCount > 0 || recurringTaskCount > 0) {
                throw new GraphQLError(
                    `This member still has ${taskCount} task(s) and ${recurringTaskCount} recurring task(s) assigned. Provide reassignTo to transfer them first, or reassign manually.`,
                    { extensions: { code: 'MEMBER_HAS_ASSIGNMENTS', taskCount, recurringTaskCount } }
                );
            }
        }

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

//Edit a member's profile. Called by both actor types:
//  - a member editing their OWN profile: uuid must come from their verified token (resolver
//    passes caller.uuid, never client input), groupId omitted (self-edit needs no extra check)
//  - a user (admin) editing a member they manage: groupId is required and enforced here, so
//    an admin can't reach into another group's member by guessing a uuid
export const editMemberProfile = async (uuid, { username, email, password, avatarBase64 } = {}, groupId = null) => {
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
            //Changing the password invalidates every other outstanding token for this member —
            //including one forced by an admin resetting it on their behalf.
            fields.push(`token_version = token_version + 1`);
        }
        if (avatarBase64 !== undefined) {
            fields.push(`avatar_base64 = $${i++}`);
            values.push(avatarBase64);
        }

        if (fields.length === 0) {
            throw new Error('No fields provided to update');
        }

        values.push(uuid);
        let query = `UPDATE members SET ${fields.join(', ')} WHERE uuid = $${i}`;

        if (groupId != null) {
            values.push(groupId);
            query += ` AND group_id = $${i + 1}`;
        }

        query += ' RETURNING uuid, username, email, group_id, created_at, avatar_base64';
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

//Reads a member's own profile-picture data URL, if any — fetched on demand (not
//included in fetchMemberFromToken's per-request SELECT) to avoid loading the blob on
//every single authenticated member request, matching how the admin side's currentUser
//fetches its avatar via getUserAvatar rather than carrying it in context.
export const getMemberAvatar = async (uuid) => {
    const result = await pool.query('SELECT avatar_base64 FROM members WHERE uuid = $1', [uuid]);
    return result.rows[0]?.avatar_base64 ?? null;
};
