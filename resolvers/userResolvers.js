import { fetchCurrentUser } from '../models/userFunctions.js';
import { createRequestSupabaseClient } from '../utils/supabaseServerClient.js';

const mapUser = (user) => user && {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name ?? null,
};

const userResolvers = {
    Query: {
        // Prefers the Supabase session cookie (already resolved into context.user by
        // server.js); accessToken arg is a fallback for non-browser callers only.
        currentUser: async (_, { accessToken }, context) => {
            if (context?.user) {
                return mapUser(context.user);
            }
            if (!accessToken) {
                return null;
            }
            const user = await fetchCurrentUser(accessToken);
            return mapUser(user);
        },
    },
    Mutation: {
        // Uses a request-scoped Supabase client (see utils/supabaseServerClient.js) so the
        // resulting session is set as an httpOnly cookie on this response — never returned
        // in the body, never touched by browser JS.
        registerUser: async (_, { name, email, password }, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: { data: { name } },
            });

            if (error) {
                throw error;
            }

            return { user: mapUser(data.user) };
        },
        loginUser: async (_, { email, password }, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });

            if (error) {
                throw error;
            }

            return { user: mapUser(data.user) };
        },
        signOutUser: async (_, __, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { error } = await supabase.auth.signOut();

            if (error) {
                throw error;
            }

            return true;
        },
    },
};

export default userResolvers;
