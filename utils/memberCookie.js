export const MEMBER_COOKIE_NAME = 'memberToken';

//httpOnly means page JavaScript can never read this cookie — an XSS payload that can run
//arbitrary JS in the member portal still can't exfiltrate the token, unlike the old
//localStorage approach. secure requires NODE_ENV=production to be set on the real
//deployment, or the browser will refuse to send the cookie back over HTTPS.
//sameSite defaults to 'lax' (fine for a frontend/backend on the same registrable domain,
//e.g. app.example.com + api.example.com); override via COOKIE_SAME_SITE=none if they end
//up on genuinely unrelated domains (requires secure: true, i.e. HTTPS, to work at all).
export const memberCookieOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.COOKIE_SAME_SITE ?? 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000, // 1 day — matches the member JWT's own expiry
});
