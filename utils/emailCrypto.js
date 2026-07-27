import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(process.env.EMAIL_CREDENTIALS_SECRET, "hex");

//Encrypts a Gmail app password for storage — reversible (not hashed), since we need
//the plaintext back later to authenticate with Gmail's SMTP server via nodemailer
export const encryptSecret = (plaintext) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, KEY, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
};

export const decryptSecret = (stored) => {
    const [ivHex, authTagHex, encryptedHex] = stored.split(":");
    const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, "hex")),
        decipher.final(),
    ]);

    return decrypted.toString("utf8");
};
