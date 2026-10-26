import { sql } from "@vercel/postgres";
import { randomUUID } from "node:crypto";
import { ensureSchema } from "./server-db";

export class AuthIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthIdentityError";
  }
}

export class DeletedAuthIdentityError extends AuthIdentityError {
  constructor() {
    super("This account has been deleted");
    this.name = "DeletedAuthIdentityError";
  }
}

/** Resolve a server-side WorkOS SDK user. Only the opaque subject establishes identity. */
export async function resolveWorkOSUserId(user: {
  id: string;
  externalId?: string | null;
}): Promise<string> {
  if (!user.id) throw new AuthIdentityError("WorkOS user ID is required");
  await ensureSchema();
  const { rows } = await sql.query<{ user_id: string }>(
    "SELECT user_id FROM auth_identities WHERE provider = 'workos' AND subject = $1",
    [user.id],
  );
  if (rows[0]) return rows[0].user_id;

  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    // A row lock cannot protect a subject's first login, before its row exists.
    // Hash collisions merely serialize unrelated logins; IDs remain exact text.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["workos", user.id])],
    );
    const existing = (
      await client.query<{ user_id: string }>(
        "SELECT user_id FROM auth_identities WHERE provider = 'workos' AND subject = $1",
        [user.id],
      )
    ).rows[0];

    let userId = existing?.user_id;
    if (userId === undefined) {
      // Check AFTER looking up the mapping: deletion commits its removal and this marker
      // together. A concurrent lookup either returns the old (write-fenced) owner or sees
      // the marker here; it must never provision a new owner for a still-valid session.
      const revoked = await client.query(
        `SELECT 1 FROM revoked_auth_identities
         WHERE provider = 'workos' AND subject_hash = sha256(convert_to($1, 'UTF8'))`,
        [user.id],
      );
      if (revoked.rows.length) throw new DeletedAuthIdentityError();

      // Do not inherit data even if a UUID happens to match an unimported legacy owner.
      while (userId === undefined) {
        const candidate = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO application_users(id)
           SELECT $1 WHERE NOT EXISTS (
             SELECT 1 FROM projects WHERE user_id = $1
             UNION ALL SELECT 1 FROM contracts WHERE user_id = $1
             UNION ALL SELECT 1 FROM contract_files WHERE user_id = $1
             UNION ALL SELECT 1 FROM chat_threads WHERE user_id = $1
             UNION ALL SELECT 1 FROM user_settings WHERE user_id = $1
           ) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [candidate],
        );
        userId = inserted.rows[0]?.id;
      }
      const linked = await client.query<{ user_id: string }>(
        `INSERT INTO auth_identities(provider, subject, user_id)
         VALUES ('workos', $1, $2) ON CONFLICT DO NOTHING RETURNING user_id`,
        [user.id, userId],
      );
      if (!linked.rows.length) {
        throw new AuthIdentityError(
          "Application owner already has a WorkOS identity",
        );
      }
    }
    await client.query("COMMIT");
    return userId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
