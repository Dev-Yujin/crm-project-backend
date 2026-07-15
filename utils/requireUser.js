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
