import { initializeApp, cert } from "firebase-admin/app";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const rawBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64;
if (!rawBase64) {
  throw new Error(
    "GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64 is not set — the backend cannot authenticate to Firebase without it. " +
    "Set it to the base64 encoding of your Firebase service account key JSON (see docs/superpowers/specs/2026-08-27-firebase-admin-sdk-write-lockdown-design.md). " +
    "Base64 is used instead of raw JSON because some hosting panels (e.g. Hostinger) mangle the quotes/braces of a raw JSON env var value."
  );
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8"));
} catch (err) {
  throw new Error(`GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64 does not decode to valid JSON: ${err.message}`);
}

// Initialize Firebase Admin SDK — a trusted service-account credential that
// bypasses RTDB security rules entirely, by design. This is what lets the
// backend keep writing once rules are tightened to .write: false for everyone
// else (see the design spec's rollout plan).
export const app = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
