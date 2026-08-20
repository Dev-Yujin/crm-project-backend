import { createServerClient } from '@supabase/ssr';

//One of these per request — wires @supabase/ssr's cookie-based session storage straight
//into this Express request/response. login/register/OAuth/refresh all read and write the
//session (and, during OAuth, the PKCE code_verifier) via httpOnly cookies through this
//adapter — this is what keeps the admin session out of localStorage entirely, unlike the
//old approach of the frontend calling supabase-js directly with its own default storage.
//
//@supabase/ssr defaults new cookies to httpOnly: false (browser-readable) — every cookie
//it wants to set is forced back to httpOnly here regardless of what it asks for; that's
//the whole point of routing auth through the backend instead of the browser.
export const createRequestSupabaseClient = (req, res) => {
    return createServerClient(process.env.SUPABASE_PROJECT_URL, process.env.SUPABASE_ANON_KEY, {
        cookies: {
            getAll: () => Object.entries(req.cookies ?? {}).map(([name, value]) => ({ name, value })),
            setAll: (cookiesToSet) => {
                cookiesToSet.forEach(({ name, value, options }) => {
                    res.cookie(name, value, {
                        ...options,
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production',
                        sameSite: process.env.COOKIE_SAME_SITE ?? 'lax',
                    });
                });
            },
        },
    });
};
