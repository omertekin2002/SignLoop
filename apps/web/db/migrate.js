import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@vercel/postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  for (const file of migrationFiles) {
    const migrationPath = path.join(__dirname, 'migrations', file);
    const contents = await readFile(migrationPath, 'utf8');
    const statements = contents
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await client.query(statement);
    }

    console.log(`Applied ${file}`);
  }
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await client.end();
}
