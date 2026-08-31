import { joinGroupByCode, getMyGroup, getGroupUsers } from '../models/groups.js';
import { requireUser, requireGroup } from '../utils/requireUser.js';

const mapGroupUser = (row) => ({
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
    avatarBase64: row.avatar_base64 ?? null,
});

const groupResolvers = {
    Query: {
        myGroup: async (_, __, context) => {
            const user = requireUser(context);
            return getMyGroup(user.id);
        },
        groupUsers: async (_, __, context) => {
            const groupId = requireGroup(context);
            const users = await getGroupUsers(groupId);
            return users.map(mapGroupUser);
        },
    },
    Mutation: {
        joinGroup: async (_, { joinCode }, context) => {
            const user = requireUser(context);
            return joinGroupByCode(user.id, joinCode);
        },
    },
};

export default groupResolvers;
