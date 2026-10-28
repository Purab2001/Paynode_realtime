import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(5001),
  // Comma-separated list of allowed browser origins.
  CLIENT_URL: z.string().default("http://localhost:5173"),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).default("paynode"),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  REALTIME_SECRET: z.string().min(16).optional(),
});

// A variable that exists but is blank (easy to leave behind in a hosting dashboard) counts as not set.
const present = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ""));
const parsed = schema.safeParse(present);
if (!parsed.success) {
  console.error("Invalid environment:", z.flattenError(parsed.error).fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
export const allowedOrigins = env.CLIENT_URL.split(",").map((o) => o.trim()).filter(Boolean);
