import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Reuse the client across HMR reloads in dev to avoid exhausting connections.
const globalForDb = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
};

// Enforce TLS to a remote DB by setting DATABASE_SSL=require (or put
// ?sslmode=require in DATABASE_URL). Left off by default so the local docker DB
// over plaintext keeps working.
const ssl =
  process.env.DATABASE_SSL === "require" || process.env.DATABASE_SSL === "true"
    ? ("require" as const)
    : undefined;

const client =
  globalForDb.pgClient ??
  postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl,
  });
globalForDb.pgClient = client;

export const db = drizzle(client, { schema, casing: "snake_case" });
export { schema };
