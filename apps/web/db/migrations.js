import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function runMigrations(client) {
  const directory = path.join(process.cwd(), "db", "migrations");
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  await client.query("SELECT pg_advisory_lock(736194821)");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.filename));
    for (const file of files) {
      if (applied.has(file)) continue;
      const contents = await readFile(path.join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(contents);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(736194821)");
  }
}
