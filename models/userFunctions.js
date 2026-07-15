import { supabaseAuth } from '../config/supabase.js';
// Register, Login, and Google OAuth functions using Supabase Auth

//Register function (email/password sign up)
export const registerUser = async (name, email, password) => {
    const { data, error } = await supabaseAuth.auth.signUp({
        email,
        password,
        options: {
            data: { name },
        },
    });

    if (error) {
        console.error('Error registering user:', error.message);
        throw error;
    }

    return data;
};

//Login function (email/password sign in)
export const loginUser = async (email, password) => {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
        email,
        password,
    });

    if (error) {
        console.error('Error logging in user:', error.message);
        throw error;
    }

    return data;
};

//Google OAuth sign in/sign up (returns the URL to redirect the user to)
export const signInWithGoogle = async (redirectTo) => {
    const { data, error } = await supabaseAuth.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
    });

    if (error) {
        console.error('Error starting Google sign in:', error.message);
        throw error;
    }

    return data;
};

//Fetch the currently authenticated user from an access token
export const fetchCurrentUser = async (accessToken) => {
    const { data, error } = await supabaseAuth.auth.getUser(accessToken);

    if (error) {
        console.error('Error fetching current user:', error.message);
        throw error;
    }

    return data.user;
};

//Sign out function
export const signOutUser = async () => {
    const { error } = await supabaseAuth.auth.signOut();

    if (error) {
        console.error('Error signing out user:', error.message);
        throw error;
    }

    return true;
};
