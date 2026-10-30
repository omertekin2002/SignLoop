import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runMigrations } from "../db/migrations.js";

// Opt in only against the disposable database created by db/test-integration.sh.
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

import {
  createAnalysisForContract,
  createContractForUser,
  createProjectForUser,
  deleteAccountForUser,
  deleteAnalysisForContract,
  deleteContractForUser,
  deleteProjectForUser,
  getContractNotesForUser,
  getContractWithLatestAnalysisForUser,
  saveContractNotesForUser,
  saveContractUploadForUser,
} from "./server-db";

// db/test-integration.sh sets this and runs vitest directly, outside turbo's env filtering.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.REQUIRE_DB_TESTS === "1" && !connectionString)
  throw new Error(
    "REQUIRE_DB_TESTS=1 but SIGNLOOP_TEST_DATABASE_URL is unset; refusing to skip the database suite",
  );

/** The revision a client holds after reading updatedAt through JSON. */
const revision = (notes: { updatedAt: unknown }) =>
  new Date(notes.updatedAt as string).toISOString();

const notes = (acceptanceReasons: string, openQuestions = "") => ({ acceptanceReasons, openQuestions });

describe.skipIf(!connectionString)("contract notes database integration", () => {
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

  /** A fresh signed-in owner, as identity provisioning creates one. */
  async function owner() {
    const userId = `notes-owner-${randomUUID()}`;
    await pool.current!.query("INSERT INTO application_users(id) VALUES ($1)", [userId]);
    return userId;
  }
  async function storedNotes(contractId: string) {
    return (
      await pool.current!.query(
        "SELECT user_id, acceptance_reasons, open_questions, updated_at FROM contract_notes WHERE contract_id = $1",
        [contractId],
      )
    ).rows;
  }

  it("records migration 022 and applies it to a populated schema without touching existing rows", async () => {
    const { rows } = await pool.current!.query(
      "SELECT filename FROM schema_migrations WHERE filename = '022_contract_notes.sql'",
    );
    expect(rows).toHaveLength(1);

    const migration = await readFile(
      new URL("../db/migrations/022_contract_notes.sql", import.meta.url),
      "utf8",
    );
    const client = await pool.current!.connect();
    // Replay the migration against tables as 021 leaves them, with rows, in a private transaction.
    const schema = `notes_migration_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query("CREATE TABLE application_users (id text PRIMARY KEY)");
      await client.query(
        "CREATE TABLE contracts (id uuid PRIMARY KEY, user_id text NOT NULL, title text NOT NULL)",
      );
      const contractId = randomUUID();
      await client.query("INSERT INTO application_users VALUES ('existing-owner')");
      await client.query("INSERT INTO contracts VALUES ($1, 'existing-owner', 'Existing')", [contractId]);

      await client.query(migration);

      expect((await client.query("SELECT * FROM contracts")).rows).toEqual([
        { id: contractId, user_id: "existing-owner", title: "Existing" },
      ]);
      expect((await client.query("SELECT * FROM contract_notes")).rows).toEqual([]);
      const inserted = await client.query(
        `INSERT INTO contract_notes(contract_id, user_id, acceptance_reasons)
         VALUES ($1, 'existing-owner', 'Fair rent') RETURNING open_questions`,
        [contractId],
      );
      expect(inserted.rows[0]).toMatchObject({ open_questions: "" });
      await client.query("DELETE FROM contracts WHERE id = $1", [contractId]);
      expect((await client.query("SELECT * FROM contract_notes")).rows).toEqual([]);
    } finally {
      // Also removes the private schema and its fixtures.
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("bounds each note to 10,000 code points and stores timestamps in whole milliseconds", async () => {
    const userId = await owner();
    const contract = await createContractForUser({ userId, title: "Lease" });
    const insert = (acceptance: string, questions: string) =>
      pool.current!.query(
        "INSERT INTO contract_notes(contract_id, user_id, acceptance_reasons, open_questions) VALUES ($1, $2, $3, $4)",
        [contract.id, userId, acceptance, questions],
      );
    await expect(insert("a".repeat(10_001), "")).rejects.toThrow(/check constraint/);
    await expect(insert("", "a".repeat(10_001))).rejects.toThrow(/check constraint/);
    // char_length counts code points: 10,000 emoji are 20,000 UTF-16 code units.
    await expect(insert("😀".repeat(10_000), "a".repeat(10_000))).resolves.toBeDefined();
    const { rows } = await pool.current!.query(
      `SELECT extract(microseconds FROM created_at)::bigint % 1000 AS created,
         extract(microseconds FROM updated_at)::bigint % 1000 AS updated
       FROM contract_notes WHERE contract_id = $1`,
      [contract.id],
    );
    expect(rows).toEqual([{ created: "0", updated: "0" }]);
  });

  it("reads and saves notes for the owner only, leaking nothing to another user", async () => {
    const userId = await owner();
    const intruder = await owner();
    const contract = await createContractForUser({ userId, title: "Lease" });

    expect(await getContractNotesForUser(userId, contract.id)).toEqual({
      contractId: contract.id, acceptanceReasons: "", openQuestions: "", createdAt: null, updatedAt: null,
    });
    expect(await getContractNotesForUser(intruder, contract.id)).toBeNull();
    expect(await getContractNotesForUser(userId, randomUUID())).toBeNull();

    // Another user cannot create the notes, whatever revision they claim.
    expect(await saveContractNotesForUser(intruder, contract.id, notes("Mine now"), null)).toEqual({ status: "not_found" });
    expect(await storedNotes(contract.id)).toEqual([]);
    expect(await saveContractNotesForUser(userId, randomUUID(), notes("Nowhere"), null)).toEqual({ status: "not_found" });

    const created = await saveContractNotesForUser(userId, contract.id, notes("Fair rent", "Who fixes the boiler?"), null);
    expect(created).toMatchObject({
      status: "saved",
      notes: { contractId: contract.id, acceptanceReasons: "Fair rent", openQuestions: "Who fixes the boiler?" },
    });
    if (created.status !== "saved") throw new Error("expected a save");
    expect(created.notes.createdAt).toEqual(created.notes.updatedAt);
    expect(await getContractNotesForUser(userId, contract.id)).toEqual(created.notes);
    expect((await storedNotes(contract.id))[0]).toMatchObject({ user_id: userId });

    // Nor read, overwrite, or learn the current revision of the owner's notes.
    expect(await getContractNotesForUser(intruder, contract.id)).toBeNull();
    expect(await saveContractNotesForUser(intruder, contract.id, notes("Mine now"), revision(created.notes))).toEqual({ status: "not_found" });
    expect(await saveContractNotesForUser(intruder, contract.id, notes("Mine now"), null)).toEqual({ status: "not_found" });
    expect(await getContractNotesForUser(userId, contract.id)).toEqual(created.notes);
  });

  it("rejects a save from a stale revision with the stored notes, changing nothing", async () => {
    const userId = await owner();
    const contract = await createContractForUser({ userId, title: "Lease" });
    const first = await saveContractNotesForUser(userId, contract.id, notes("First"), null);
    if (first.status !== "saved") throw new Error("expected a save");

    // A second "first save" from another tab finds notes already there.
    const duplicate = await saveContractNotesForUser(userId, contract.id, notes("Other tab"), null);
    expect(duplicate).toEqual({ status: "conflict", notes: first.notes });

    // Revisions only move forward, so a save never reuses one, even when the clock has not passed
    // the stored revision (here pushed an hour ahead).
    await pool.current!.query(
      "UPDATE contract_notes SET updated_at = updated_at + interval '1 hour' WHERE contract_id = $1",
      [contract.id],
    );
    const ahead = await getContractNotesForUser(userId, contract.id);
    const second = await saveContractNotesForUser(userId, contract.id, notes("Second"), revision(ahead!));
    if (second.status !== "saved") throw new Error("expected a save");
    expect(new Date(second.notes.updatedAt!).getTime() - new Date(ahead!.updatedAt!).getTime()).toBe(1);
    const third = await saveContractNotesForUser(userId, contract.id, notes("Third"), revision(second.notes));
    if (third.status !== "saved") throw new Error("expected a save");
    expect(revision(second.notes) > revision(first.notes)).toBe(true);
    expect(revision(third.notes) > revision(second.notes)).toBe(true);
    expect(third.notes.createdAt).toEqual(first.notes.createdAt);

    const before = await storedNotes(contract.id);
    for (const stale of [revision(first.notes), revision(second.notes), "2000-01-01T00:00:00.000Z"]) {
      expect(await saveContractNotesForUser(userId, contract.id, notes("Stale tab"), stale)).toEqual({
        status: "conflict",
        notes: third.notes,
      });
    }
    expect(await storedNotes(contract.id)).toEqual(before);
    expect(before[0]).toMatchObject({ acceptance_reasons: "Third" });

    // A revision for notes that were never saved is stale too.
    const empty = await createContractForUser({ userId, title: "Empty" });
    expect(await saveContractNotesForUser(userId, empty.id, notes("Ghost"), revision(first.notes))).toMatchObject({
      status: "conflict",
      notes: { acceptanceReasons: "", updatedAt: null },
    });
    expect(await storedNotes(empty.id)).toEqual([]);
  });

  it("lets exactly one of two concurrent saves from the same revision win", async () => {
    const userId = await owner();
    const contract = await createContractForUser({ userId, title: "Lease" });

    const firsts = await Promise.all(
      ["Tab A", "Tab B"].map((text) => saveContractNotesForUser(userId, contract.id, notes(text), null)),
    );
    expect(firsts.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const winner = firsts.find((result) => result.status === "saved")!;
    if (winner.status !== "saved") throw new Error("expected a save");

    const updates = await Promise.all(
      ["Tab A again", "Tab B again"].map((text) =>
        saveContractNotesForUser(userId, contract.id, notes(text), revision(winner.notes)),
      ),
    );
    expect(updates.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const saved = updates.find((result) => result.status === "saved")!;
    expect(await getContractNotesForUser(userId, contract.id)).toEqual(
      saved.status === "saved" ? saved.notes : null,
    );
  });

  it("keeps notes through re-uploads and analyses, and deletes them with the contract or its project", async () => {
    const userId = await owner();
    const project = await createProjectForUser({ userId, title: "Office" });
    const contract = await createContractForUser({ userId, title: "Lease", projectId: project.id });
    const loose = await createContractForUser({ userId, title: "Loose" });
    const saved = await saveContractNotesForUser(userId, contract.id, notes("Fair rent", "Deposit?"), null);
    if (saved.status !== "saved") throw new Error("expected a save");
    await saveContractNotesForUser(userId, loose.id, notes("Short term"), null);

    const upload = (text: string) =>
      saveContractUploadForUser({
        userId, contractId: contract.id, projectId: project.id, title: "Lease", fileName: "lease.txt",
        storageKey: `notes-file-${randomUUID()}`, bucket: "test", contentType: "text/plain",
        sizeBytes: text.length, extractionMethod: null, extractionConfidence: null, text,
      });
    const analyse = async () => {
      const snapshot = await getContractWithLatestAnalysisForUser(userId, contract.id);
      return createAnalysisForContract({
        userId, contractId: contract.id, expectedRevision: snapshot!.revision, riskBadge: "LOW",
        resultJson: { summary: "Fine" }, llmProvider: "test", llmModel: "test",
      });
    };
    expect(await upload("First lease.")).toBe(true);
    const analysis = await analyse();
    expect(await upload("Second lease.")).toBe(true);
    await analyse();
    expect(await deleteAnalysisForContract({ userId, contractId: contract.id, analysisId: analysis.id })).toBe(true);
    expect(await getContractNotesForUser(userId, contract.id)).toEqual(saved.notes);

    expect(await deleteContractForUser({ userId, contractId: loose.id })).toEqual({ deleted: true });
    expect(await storedNotes(loose.id)).toEqual([]);
    expect(await deleteProjectForUser({ userId, projectId: project.id })).toEqual({ deleted: true });
    expect(await storedNotes(contract.id)).toEqual([]);
  });

  it("deletes all of an account's notes, leaves other accounts' notes, and blocks saves afterwards", async () => {
    const deleted = await owner();
    const kept = await owner();
    const deletedContracts = [
      await createContractForUser({ userId: deleted, title: "One" }),
      await createContractForUser({ userId: deleted, title: "Two" }),
    ];
    for (const contract of deletedContracts) {
      await saveContractNotesForUser(deleted, contract.id, notes(`Notes for ${contract.title}`), null);
    }
    const keptContract = await createContractForUser({ userId: kept, title: "Kept" });
    await saveContractNotesForUser(kept, keptContract.id, notes("Keep me"), null);

    await deleteAccountForUser(deleted, { keepLogin: true });
    const remaining = await pool.current!.query("SELECT count(*)::integer AS count FROM contract_notes WHERE user_id = $1", [deleted]);
    expect(remaining.rows[0].count).toBe(0);
    await deleteAccountForUser(deleted);
    expect(await saveContractNotesForUser(deleted, deletedContracts[0]!.id, notes("After"), null)).toEqual({ status: "not_found" });
    expect(await getContractNotesForUser(kept, keptContract.id)).toMatchObject({ acceptanceReasons: "Keep me" });
  });
});
