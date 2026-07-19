import {
    getAllMembers,
    addMember,
    deleteMember,
    editMemberProfile,
    loginMember,
    fetchMemberFromToken,
} from '../models/membersFunction.js';
import { requireUser } from '../utils/requireUser.js';

const mapMember = (row) => row && {
    uuid: row.uuid,
    username: row.username,
    email: row.email,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
};

const memberResolvers = {
    Query: {
        members: async (_, __, context) => {
            requireUser(context);
            const members = await getAllMembers();
            return members.map(mapMember);
        },
        currentMember: async (_, { token }) => {
            const member = await fetchMemberFromToken(token);
            return mapMember(member);
        },
    },
    Mutation: {
        loginMember: async (_, { email, password }) => {
            const { member, token } = await loginMember(email, password);
            return { member: mapMember(member), token };
        },
        addMember: async (_, { username, email, password }, context) => {
            requireUser(context);
            const member = await addMember(username, email, password);
            return mapMember(member);
        },
        deleteMember: async (_, { uuid }, context) => {
            requireUser(context);
            const member = await deleteMember(uuid);
            return mapMember(member);
        },
        editMemberProfile: async (_, { uuid, username, email, password }) => {
            const member = await editMemberProfile(uuid, { username, email, password });
            return mapMember(member);
        },
    },
};

export default memberResolvers;
