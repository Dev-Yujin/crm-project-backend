import { GraphQLError } from 'graphql';

//Throws if the request's GraphQL context has no authenticated Supabase user
export const requireUser = (context) => {
    if (!context?.user) {
        throw new GraphQLError('You must be signed in to perform this action', {
            extensions: { code: 'UNAUTHENTICATED' },
        });
    }

    return context.user;
};

//Throws if the signed-in user isn't assigned to a group yet (assignment is manual, via Supabase Studio)
export const requireGroup = (context) => {
    requireUser(context);

    if (!context.groupId) {
        throw new GraphQLError('Your account is not assigned to a group yet. Contact an admin.', {
            extensions: { code: 'NO_GROUP' },
        });
    }

    return context.groupId;
};

//For public/member-facing reads: a signed-in user's own groupId always wins (never trust a client-supplied
//groupId once we can derive one server-side); an unauthenticated caller must supply groupId explicitly.
export const resolveGroupId = (context, suppliedGroupId) => {
    if (context?.user) {
        return requireGroup(context);
    }

    if (!suppliedGroupId) {
        throw new GraphQLError('groupId is required', { extensions: { code: 'BAD_USER_INPUT' } });
    }

    return suppliedGroupId;
};
