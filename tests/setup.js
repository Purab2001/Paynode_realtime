import { inject } from "vitest";

// Test-only values, set before src/config/env.js is imported. Real .env values are never used.
Object.assign(process.env, {
  NODE_ENV: "test",
  MONGODB_URI: inject("mongoUri"),
  MONGODB_DB: "paynode-realtime-test",
  CLIENT_URL: "http://localhost:5173",
  FIREBASE_PROJECT_ID: "test-project",
  FIREBASE_CLIENT_EMAIL: "test@test-project.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: "test-key",
  REALTIME_SECRET: "test-realtime-secret-0123456789",
});
