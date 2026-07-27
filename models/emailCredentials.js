import { pool } from "../config/supabase.js";
import { encryptSecret, decryptSecret } from "../utils/emailCrypto.js";

//Save or update the calling user's Gmail credentials (used to send member invite emails on their behalf)
export const upsertEmailCredentials = async (userId, email, appPassword) => {
    const encryptedAppPassword = encryptSecret(appPassword);

    const result = await pool.query(
        `INSERT INTO email_credentials ("userId", email, encrypted_app_password, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT ("userId") DO UPDATE
         SET email = EXCLUDED.email, encrypted_app_password = EXCLUDED.encrypted_app_password, updated_at = now()
         RETURNING email, updated_at`,
        [userId, email, encryptedAppPassword]
    );

    return { email: result.rows[0].email, updatedAt: result.rows[0].updated_at };
};

//Info only — never returns the password itself
export const getMyEmailCredentialsInfo = async (userId) => {
    const result = await pool.query(
        'SELECT email, updated_at FROM email_credentials WHERE "userId" = $1',
        [userId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return { email: result.rows[0].email, updatedAt: result.rows[0].updated_at };
};

//Internal use only (e.g. by the mailer) — returns the decrypted app password
export const getDecryptedEmailCredentials = async (userId) => {
    const result = await pool.query(
        'SELECT email, encrypted_app_password FROM email_credentials WHERE "userId" = $1',
        [userId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return {
        email: result.rows[0].email,
        appPassword: decryptSecret(result.rows[0].encrypted_app_password),
    };
};
