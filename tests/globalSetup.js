import { MongoMemoryServer } from "mongodb-memory-server";

// One in-memory MongoDB for the whole run. Tests never touch a real database.
export default async function setup({ provide }) {
  const mongo = await MongoMemoryServer.create();
  provide("mongoUri", mongo.getUri());
  return () => mongo.stop();
}
