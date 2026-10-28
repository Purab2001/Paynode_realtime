import mongoose from "mongoose";
import { env } from "../config/env.js";

export async function connectDB(uri = env.MONGODB_URI) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, { dbName: env.MONGODB_DB, autoIndex: env.NODE_ENV !== "production" });
  return mongoose.connection;
}

export const disconnectDB = () => mongoose.disconnect();
