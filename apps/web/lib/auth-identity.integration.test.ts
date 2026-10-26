import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runMigrations } from "../db/migrations.js";

// Opt in only against a disposable database, never the configured application database.
const connectionString = process.env.SIGNLOOP_TEST_DATABASE_URL;
const { pool } = vi.hoisted(() => ({ pool: { current: null as Pool | null } }));
vi.mock("@vercel/postgres", () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) =>
      pool.current!.query(
        strings.reduce(
          (query, part, index) => query + (index ? `$${index}` : "") + part,
          "",
        ),
        values,
      ),
    {
      query: (text: string, values?: unknown[]) =>
        pool.current!.query(text, values),
      connect: () => pool.current!.connect(),
    },
  );
  return { sql };
});

import { resolveWorkOSUserId } from "./auth-identity";
import {
  createProjectForUser,
  getUserSettingsByUserId,
  listProjectsByUserId,
  upsertUserSettings,
} from "./server-db";

// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.REQUIRE_DB_TESTS === "1" && !connectionString)
  throw new Error(
    "REQUIRE_DB_TESTS=1 but SIGNLOOP_TEST_DATABASE_URL is unset; refusing to skip the database suite",
  );

describe.skipIf(!connectionString)(
  "authentication identity database integration",
  () => {
    beforeAll(async () => {
      const url = new URL(connectionString!);
      if (url.hostname !== "localhost" || url.pathname !== "/signloop_test")
        throw new Error(
          "Integration tests require the disposable local signloop_test database",
        );
      pool.current = new Pool({ connectionString, max: 8 });
      const client = await pool.current.connect();
      try {
        await runMigrations(client);
        await runMigrations(client);
      } finally {
        client.release();
      }
      vi.stubEnv("SKIP_SCHEMA_BOOTSTRAP", "1");
    });

    afterAll(async () => {
      await pool.current?.end();
      vi.unstubAllEnvs();
    });

    it("creates empty identity tables without importing or modifying legacy owners", async () => {
      const migration = await readFile(
        new URL("../db/migrations/017_auth_identities.sql", import.meta.url),
        "utf8",
      );
      const client = await pool.current!.connect();
      // Exercise the migration against populated legacy tables in a private transaction.
      const schema = `identity_migration_${randomUUID().replaceAll("-", "")}`;
      const tables = [
        "projects",
        "contracts",
        "contract_files",
        "chat_threads",
        "user_settings",
      ];
      try {
        await client.query("BEGIN");
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET LOCAL search_path TO ${schema}`);
        for (const table of tables) {
          await client.query(
            `CREATE TABLE ${table} (user_id text NOT NULL, payload text)`,
          );
          await client.query(`INSERT INTO ${table} VALUES ($1, $2)`, [
            `Legacy_${table}`,
            `preserved ${table}`,
          ]);
        }
        await client.query(migration);
        expect(
          (await client.query("SELECT * FROM application_users")).rows,
        ).toEqual([]);
        expect(
          (await client.query("SELECT * FROM auth_identities")).rows,
        ).toEqual([]);
        for (const table of tables) {
          expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([
            { user_id: `Legacy_${table}`, payload: `preserved ${table}` },
          ]);
        }
      } finally {
        // Also removes the private schema and its fixtures.
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("keeps fresh accounts isolated and never links by email, external ID, or legacy owner text", async () => {
      // Legacy rows predate application users, so they are written directly.
      const legacyOwner = `Legacy_${randomUUID()}`;
      const legacyProject = (
        await pool.current!.query<{ id: string }>(
          "INSERT INTO projects(user_id, title) VALUES ($1, 'Untouched legacy project') RETURNING id",
          [legacyOwner],
        )
      ).rows[0]!;
      await pool.current!.query(
        "INSERT INTO user_settings(user_id, primary_model, personality) VALUES ($1, 'legacy-model', 'signloop-assistant')",
        [legacyOwner],
      );
      const legacySettings = await getUserSettingsByUserId(legacyOwner);
      expect(legacySettings).toMatchObject({ primaryModel: "legacy-model" });
      const first = {
        id: legacyOwner,
        externalId: legacyOwner,
        email: "shared@example.test",
      };
      const second = { ...first, id: `WorkOS_${randomUUID()}` };
      const firstOwner = await resolveWorkOSUserId(first);
      const secondOwner = await resolveWorkOSUserId(second);
      expect(firstOwner).toMatch(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      );
      expect(firstOwner).not.toBe(legacyOwner);
      expect(secondOwner).not.toBe(firstOwner);
      expect((await listProjectsByUserId(firstOwner)).data).toEqual([]);
      expect(await getUserSettingsByUserId(firstOwner)).toBeNull();
      expect(
        (await listProjectsByUserId(legacyOwner)).data.map(({ id }) => id),
      ).toEqual([legacyProject.id]);
      expect(await getUserSettingsByUserId(legacyOwner)).toEqual(
        legacySettings,
      );

      const project = await createProjectForUser({
        userId: firstOwner,
        title: "New personal project",
      });
      const settings = await upsertUserSettings({
        userId: firstOwner,
        primaryModel: "new-model",
      });
      expect(
        await resolveWorkOSUserId({ ...first, externalId: secondOwner }),
      ).toBe(firstOwner);
      expect(await resolveWorkOSUserId({ id: first.id })).toBe(firstOwner);
      expect(
        (await listProjectsByUserId(firstOwner)).data.map(({ id }) => id),
      ).toEqual([project.id]);
      expect(await getUserSettingsByUserId(firstOwner)).toEqual(settings);
      expect((await listProjectsByUserId(secondOwner)).data).toEqual([]);
      expect(await getUserSettingsByUserId(secondOwner)).toBeNull();
      expect(await getUserSettingsByUserId(legacyOwner)).toEqual(
        legacySettings,
      );
    });

    it("makes concurrent first logins for one subject idempotent", async () => {
      const subject = `WorkOS_concurrent_${randomUUID()}`;
      const owners = await Promise.all(
        Array.from({ length: 16 }, () => resolveWorkOSUserId({ id: subject })),
      );
      expect(new Set(owners).size).toBe(1);
      expect(await resolveWorkOSUserId({ id: subject })).toBe(owners[0]);
      const { rows } = await pool.current!.query(
        `SELECT i.user_id FROM auth_identities i
       JOIN application_users u ON u.id = i.user_id
       WHERE i.provider = 'workos' AND i.subject = $1`,
        [subject],
      );
      expect(rows).toEqual([{ user_id: owners[0] }]);
    });

    it("treats differently cased and whitespace-bearing WorkOS subjects as distinct", async () => {
      const subject = `WorkOS_${randomUUID()}`;
      const owners = await Promise.all(
        [subject, subject.toLowerCase(), ` ${subject} `].map((id) =>
          resolveWorkOSUserId({ id }),
        ),
      );
      expect(new Set(owners).size).toBe(3);
    });

    it("enforces subject uniqueness, one identity per provider/owner, and owner existence", async () => {
      const subject = `WorkOS_constraints_${randomUUID()}`;
      const owner = await resolveWorkOSUserId({ id: subject });
      await expect(
        pool.current!.query(
          "INSERT INTO auth_identities(provider, subject, user_id) VALUES ('workos', $1, $2)",
          [subject, owner],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.current!.query(
          "INSERT INTO auth_identities(provider, subject, user_id) VALUES ('workos', $1, $2)",
          [`Other_${randomUUID()}`, owner],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.current!.query(
          "INSERT INTO auth_identities(provider, subject, user_id) VALUES ('workos', $1, $2)",
          [`Other_${randomUUID()}`, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  },
);
