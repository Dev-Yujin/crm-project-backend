import { initializeApp, cert } from "firebase-admin/app";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!raw) {
  throw new Error(
    "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set — the backend cannot authenticate to Firebase without it. " +
    "Set it to the full contents of your Firebase service account key JSON (see docs/superpowers/specs/2026-08-27-firebase-admin-sdk-write-lockdown-design.md)."
  );
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch (err) {
  throw new Error(`GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${err.message}`);
}

// Initialize Firebase Admin SDK — a trusted service-account credential that
// bypasses RTDB security rules entirely, by design. This is what lets the
// backend keep writing once rules are tightened to .write: false for everyone
// else (see the design spec's rollout plan).
export const app = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
