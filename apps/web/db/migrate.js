import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@vercel/postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NOTE: keep this list (and the SQL files) in sync with the inline ensureSchema() bootstrap in
// lib/server-db.ts — both describe the same schema.
const migrationFiles = [
  '001_create_contract_files.sql',
  '002_create_core_entities.sql',
  '003_create_user_settings.sql',
  '004_create_chat_entities.sql',
  '005_add_user_personality.sql',
  '006_fix_contract_files_project_id_type.sql',
];

const client = createClient();
await client.connect();

try {
  // Track applied migrations so each file runs at most once instead of re-executing every run.
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows: appliedRows } = await client.query('select filename from schema_migrations');
  const applied = new Set(appliedRows.map((row) => row.filename));

  for (const file of migrationFiles) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }

    const migrationPath = path.join(__dirname, 'migrations', file);
    const contents = await readFile(migrationPath, 'utf8');

    // Run the whole file as a single multi-statement query (instead of splitting on ';', which
    // breaks on semicolons inside string literals or dollar-quoted bodies), and record it in the
    // same transaction so a file is marked applied only if it fully succeeds.
    await client.query('begin');
    try {
      await client.query(contents);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    console.log(`Applied ${file}`);
  }
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await client.end();
}
