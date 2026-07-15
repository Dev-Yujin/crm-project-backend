import {
    registerUser,
    loginUser,
    signInWithGoogle,
    fetchCurrentUser,
    signOutUser,
} from '../models/userFunctions.js';

const mapUser = (user) => user && {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name ?? null,
};

const mapSession = (session) => session && {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
};

const userResolvers = {
    Query: {
        currentUser: async (_, { accessToken }) => {
            const user = await fetchCurrentUser(accessToken);
            return mapUser(user);
        },
    },
    Mutation: {
        registerUser: async (_, { name, email, password }) => {
            const { user, session } = await registerUser(name, email, password);
            return { user: mapUser(user), session: mapSession(session) };
        },
        loginUser: async (_, { email, password }) => {
            const { user, session } = await loginUser(email, password);
            return { user: mapUser(user), session: mapSession(session) };
        },
        signInWithGoogle: async (_, { redirectTo }) => {
            const { url, provider } = await signInWithGoogle(redirectTo);
            return { url, provider };
        },
        signOutUser: async () => {
            return signOutUser();
        },
    },
};

export default userResolvers;
