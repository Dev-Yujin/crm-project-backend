import {
    addMember,
    deleteMember,
    editMemberProfile,
} from '../models/membersFunction.js';
import { requireUser } from '../utils/requireUser.js';

const mapMember = (row) => row && {
    uuid: row.uuid,
    username: row.username,
    email: row.email,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
};

const memberResolvers = {
    Mutation: {
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
