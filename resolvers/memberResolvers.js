import {
    getAllMembers,
    addMember,
    deleteMember,
    editMemberProfile,
    loginMember,
    fetchMemberFromToken,
    revokeMemberSessions,
    getMemberAvatar,
} from '../models/membersFunction.js';
import { getDecryptedEmailCredentials } from '../models/emailCredentials.js';
import { sendMemberInviteEmail } from '../utils/mailer.js';
import { requireUser, requireGroup, requireMember } from '../utils/requireUser.js';
import { MEMBER_COOKIE_NAME, memberCookieOptions } from '../utils/memberCookie.js';
import { GraphQLError } from 'graphql';
import { validateAvatarBase64 } from '../utils/avatar.js';

const mapMember = (row, avatarBase64) => row && {
    uuid: row.uuid,
    username: row.username,
    email: row.email,
    groupId: row.group_id ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
    avatarBase64: avatarBase64 !== undefined ? avatarBase64 : (row.avatar_base64 ?? null),
};

const memberResolvers = {
    Query: {
        members: async (_, __, context) => {
            const groupId = requireGroup(context);
            const members = await getAllMembers(groupId);
            return members.map((row) => mapMember(row));
        },
        // Prefers the Authorization header (see server.js context); the `token` argument is
        // accepted only as a fallback for callers not yet migrated to the header — see
        // SECURITY_BACKEND_ACTION_PLAN.md #4.
        currentMember: async (_, { token }, context) => {
            if (context?.member) {
                const avatarBase64 = await getMemberAvatar(context.member.uuid);
                return mapMember(context.member, avatarBase64);
            }
            if (!token) {
                return null;
            }
            const member = await fetchMemberFromToken(token);
            const avatarBase64 = await getMemberAvatar(member.uuid);
            return mapMember(member, avatarBase64);
        },
    },
    Mutation: {
        // The token is set as an httpOnly cookie, never returned in the response body —
        // page JavaScript (and anything that might run via XSS) can't read it, so there's
        // nothing for a browser client to store. See MEMBER_SECURITY_INTEGRATION.md.
        loginMember: async (_, { email, password }, context) => {
            const { member, token } = await loginMember(email, password);
            context.res.cookie(MEMBER_COOKIE_NAME, token, memberCookieOptions());
            return { member: mapMember(member) };
        },
        logoutMember: async (_, __, context) => {
            context.res.clearCookie(MEMBER_COOKIE_NAME, memberCookieOptions());
            return true;
        },
        addMember: async (_, { username, email, password, sendInvite }, context) => {
            const user = requireUser(context);
            const groupId = requireGroup(context);

            // Fail fast, before creating anything, if an invite was requested but this
            // user hasn't configured Gmail credentials yet (see updateEmailCredentials).
            let credentials = null;
            if (sendInvite) {
                credentials = await getDecryptedEmailCredentials(user.id);
                if (!credentials) {
                    throw new GraphQLError(
                        'Email credentials not configured — set them via updateEmailCredentials first, or add this member without sendInvite.',
                        { extensions: { code: 'EMAIL_CREDENTIALS_NOT_CONFIGURED' } }
                    );
                }
            }

            const member = await addMember(username, email, password, groupId);

            if (!credentials) {
                return mapMember(member);
            }

            // Member is already created at this point — a failed send doesn't roll that back,
            // it's just reported back via inviteSent/inviteError so the caller can retry the email.
            try {
                await sendMemberInviteEmail({
                    gmailUser: credentials.email,
                    gmailAppPassword: credentials.appPassword,
                    toEmail: email,
                    memberUsername: username,
                    memberPassword: password,
                });
                return { ...mapMember(member), inviteSent: true, inviteError: null };
            } catch (error) {
                console.error('Error sending member invite email:', error);
                return { ...mapMember(member), inviteSent: false, inviteError: error.message };
            }
        },
        deleteMember: async (_, { uuid }, context) => {
            const groupId = requireGroup(context);
            const member = await deleteMember(uuid, groupId);
            return mapMember(member);
        },
        // Called by both actor types: a user (admin) editing a member they manage — uuid arg
        // is required and scoped to the caller's own group — or a member editing their OWN
        // profile, where the uuid arg is ignored and identity comes from their token instead.
        editMemberProfile: async (_, { uuid, username, email, password, avatarBase64 }, context) => {
            if (avatarBase64 !== undefined) {
                try {
                    validateAvatarBase64(avatarBase64);
                } catch (err) {
                    throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
                }
            }
            if (context?.user) {
                const groupId = requireGroup(context);
                const member = await editMemberProfile(uuid, { username, email, password, avatarBase64 }, groupId);
                return mapMember(member);
            }
            const caller = requireMember(context);
            const member = await editMemberProfile(caller.uuid, { username, email, password, avatarBase64 });
            return mapMember(member);
        },
        // Admin action: force-logout a member by invalidating every outstanding token they hold.
        revokeMemberSessions: async (_, { uuid }, context) => {
            const groupId = requireGroup(context);
            return revokeMemberSessions(uuid, groupId);
        },
    },
};

export default memberResolvers;
