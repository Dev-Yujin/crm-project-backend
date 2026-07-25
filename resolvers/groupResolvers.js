import { createGroup, joinGroupByCode, getMyGroup } from '../models/groups.js';
import { requireUser } from '../utils/requireUser.js';

const groupResolvers = {
    Query: {
        myGroup: async (_, __, context) => {
            const user = requireUser(context);
            return getMyGroup(user.id);
        },
    },
    Mutation: {
        createGroup: async (_, __, context) => {
            const user = requireUser(context);
            return createGroup(user.id);
        },
        joinGroup: async (_, { joinCode }, context) => {
            const user = requireUser(context);
            return joinGroupByCode(user.id, joinCode);
        },
    },
};

export default groupResolvers;
