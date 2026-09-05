import { createClient } from "@vercel/postgres";
import { runMigrations } from "./migrations.js";

const client = createClient();
await client.connect();
try {
  await runMigrations(client);
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
