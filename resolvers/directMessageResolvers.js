import { GraphQLError } from 'graphql';
import {
    listChatContacts,
    listDirectConversations,
    listDirectMessages,
    markDirectConversationRead,
    sendDirectMessage,
    userKey,
    memberKey,
} from '../models/directMessages.js';
import { requireGroup } from '../utils/requireUser.js';

// Who's calling, as a chat participant. Identity always comes from the session —
// never from an argument — so nobody can read or send as someone else.
export const resolveChatIdentity = (context) => {
    if (context?.user) {
        const groupId = requireGroup(context);
        const meta = context.user.user_metadata ?? {};
        return {
            key: userKey(context.user.id),
            name: meta.name?.trim() || context.user.email || 'Admin',
            groupId,
        };
    }
    if (context?.member) {
        return {
            key: memberKey(context.member.uuid),
            name: context.member.username,
            groupId: context.member.group_id,
        };
    }
    throw new GraphQLError('You must be signed in to perform this action', {
        extensions: { code: 'UNAUTHENTICATED' },
    });
};

const directMessageResolvers = {
    Query: {
        chatContacts: async (_, __, context) => {
            const me = resolveChatIdentity(context);
            return listChatContacts(me.groupId, me.key);
        },
        directConversations: async (_, __, context) => {
            const me = resolveChatIdentity(context);
            return listDirectConversations(me.groupId, me.key);
        },
        directMessages: async (_, { withKey, before, limit }, context) => {
            const me = resolveChatIdentity(context);
            return listDirectMessages(me.groupId, me.key, withKey, { before, limit });
        },
    },
    Mutation: {
        sendDirectMessage: async (_, { toKey, text }, context) => {
            const me = resolveChatIdentity(context);
            return sendDirectMessage(me.groupId, me, toKey, text);
        },
        markDirectConversationRead: async (_, { withKey }, context) => {
            const me = resolveChatIdentity(context);
            return markDirectConversationRead(me.groupId, me.key, withKey);
        },
    },
};

export default directMessageResolvers;
