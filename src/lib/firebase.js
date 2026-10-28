import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { env } from "../config/env.js";

let auth;

/** Lazily initialised Firebase Admin Auth (one app per process). */
export function getFirebaseAuth() {
  if (auth) return auth;
  const app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        // .env files store the key with literal "\n" sequences.
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  auth = getAuth(app);
  return auth;
}
