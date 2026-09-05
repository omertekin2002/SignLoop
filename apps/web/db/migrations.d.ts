export function runMigrations(client: {
  query: (text: string, values?: string[]) => Promise<{ rows: { filename: string }[] }>;
}): Promise<void>;
