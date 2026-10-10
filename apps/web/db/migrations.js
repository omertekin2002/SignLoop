import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// A transaction-scoped lock is released by COMMIT or ROLLBACK on the backend that took it, which
// also holds behind a transaction-mode pooler. Each file keeps its own transaction so a file's
// SET LOCAL settings (006 sets lock_timeout) never reach later files.
async function withMigrationLock(client, work) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(736194821)");
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function runMigrations(client) {
  const directory = path.join(process.cwd(), "db", "migrations");
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  const applied = await withMigrationLock(client, async () => {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    return new Set(rows.map((row) => row.filename));
  });
  for (const file of files) {
    if (applied.has(file)) continue;
    const contents = await readFile(path.join(directory, file), "utf8");
    await withMigrationLock(client, async () => {
      // Another instance may have applied this file while we waited for the lock.
      const { rows } = await client.query(
        "SELECT filename FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (rows.length) return;
      await client.query(contents);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    });
  }
}
