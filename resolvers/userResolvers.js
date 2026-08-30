import { GraphQLError } from 'graphql';
import { fetchCurrentUser } from '../models/userFunctions.js';
import { createRequestSupabaseClient } from '../utils/supabaseServerClient.js';
import { requireUser } from '../utils/requireUser.js';
import { getUserAvatar, updateUserAvatar } from '../models/groups.js';
import { validateAvatarBase64 } from '../utils/avatar.js';

const mapUser = (user, avatarBase64 = null) => user && {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name ?? null,
    avatarBase64,
};

const userResolvers = {
    Query: {
        // Prefers the Supabase session cookie (already resolved into context.user by
        // server.js); accessToken arg is a fallback for non-browser callers only.
        currentUser: async (_, { accessToken }, context) => {
            if (context?.user) {
                const avatarBase64 = await getUserAvatar(context.user.id);
                return mapUser(context.user, avatarBase64);
            }
            if (!accessToken) {
                return null;
            }
            const user = await fetchCurrentUser(accessToken);
            const avatarBase64 = await getUserAvatar(user.id);
            return mapUser(user, avatarBase64);
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

            // A freshly registered user cannot have an avatar yet — no need to query.
            return { user: mapUser(data.user, null) };
        },
        loginUser: async (_, { email, password }, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });

            if (error) {
                throw error;
            }

            const avatarBase64 = await getUserAvatar(data.user.id);
            return { user: mapUser(data.user, avatarBase64) };
        },
        signOutUser: async (_, __, context) => {
            const supabase = createRequestSupabaseClient(context.req, context.res);
            const { error } = await supabase.auth.signOut();

            if (error) {
                throw error;
            }

            return true;
        },
        // Updates whichever of name/avatarBase64 was provided. avatarBase64: null clears
        // the photo; omitting it entirely leaves the stored value untouched.
        updateUserProfile: async (_, { name, avatarBase64 }, context) => {
            const user = requireUser(context);

            if (avatarBase64 !== undefined) {
                try {
                    validateAvatarBase64(avatarBase64);
                } catch (err) {
                    throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
                }
                await updateUserAvatar(user.id, avatarBase64);
            }

            if (name !== undefined) {
                const supabase = createRequestSupabaseClient(context.req, context.res);
                const { error } = await supabase.auth.updateUser({ data: { name } });
                if (error) {
                    throw error;
                }
            }

            const freshAvatarBase64 = await getUserAvatar(user.id);
            return mapUser(
                { ...user, user_metadata: { ...user.user_metadata, ...(name !== undefined ? { name } : {}) } },
                freshAvatarBase64,
            );
        },
    },
};

export default userResolvers;
