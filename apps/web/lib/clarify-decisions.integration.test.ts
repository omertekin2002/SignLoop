import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runMigrations } from "../db/migrations.js";
import { contractSourceRevision } from "./analysis-sources";
import { questionDecisionKey, unstatedDecisionKey } from "./clarify-keys";
import { createAccountExport } from "./account-export";
import { json, unzip } from "./test-unzip";
import {
  CONTRACT_ID as FIXTURE_CONTRACT_ID,
  CONTRACT_TEXT,
  REVISION,
  storedAnalysis,
} from "./fixtures/clarify-analysis";

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
  deleteAccountForUser,
  deleteAnalysisForContract,
  deleteClarifyDecisionForUser,
  deleteContractForUser,
  getAccountExportForUser,
  getContractWithLatestAnalysisForUser,
  listClarifyDecisionsForUser,
  saveClarifyDecisionForUser,
  saveContractUploadForUser,
  type ClarifyDecisionInput,
} from "./server-db";

// db/test-integration.sh sets this and runs vitest directly, outside turbo's env filtering.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.REQUIRE_DB_TESTS === "1" && !connectionString)
  throw new Error(
    "REQUIRE_DB_TESTS=1 but SIGNLOOP_TEST_DATABASE_URL is unset; refusing to skip the database suite",
  );

/** The revision a client holds after reading updatedAt through JSON. */
const revision = (decision: { updatedAt: unknown }) =>
  new Date(decision.updatedAt as string).toISOString();

/** Decisions saved in one millisecond list in id order, so compare them sorted. */
const byId = <T extends { id: string }>(rows: readonly T[] | null | undefined) =>
  [...(rows ?? [])].sort((a, b) => a.id.localeCompare(b.id));

const TERM_KEY = unstatedDecisionKey("Term");
const QUESTION = "How much is the early exit fee?";
const QUESTION_KEY = questionDecisionKey(QUESTION);

describe.skipIf(!connectionString)("clarify decisions database integration", () => {
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
    const userId = `decisions-owner-${randomUUID()}`;
    await pool.current!.query("INSERT INTO application_users(id) VALUES ($1)", [userId]);
    return userId;
  }

  /** The fixture analysis, re-pointed at `contractId`. */
  function analysisFor(contractId: string, result: unknown = storedAnalysis()) {
    return JSON.parse(JSON.stringify(result).replaceAll(FIXTURE_CONTRACT_ID, contractId)) as Record<string, unknown>;
  }

  /** A contract holding the fixture text, analysed `times` times; returns the analyses' ids. */
  async function analysedContract(
    userId: string,
    options: { resultJson?: (contractId: string) => unknown; times?: number } = {},
  ) {
    const contract = await createContractForUser({ userId, title: "Gym" });
    expect(
      await saveContractUploadForUser({
        userId, contractId: contract.id, projectId: null, title: "Gym", fileName: "gym.txt",
        storageKey: `decisions-file-${randomUUID()}`, bucket: "test", contentType: "text/plain",
        sizeBytes: CONTRACT_TEXT.length, extractionMethod: null, extractionConfidence: null, text: CONTRACT_TEXT,
      }),
    ).toBe(true);
    const analysisIds: string[] = [];
    for (let index = 0; index < (options.times ?? 1); index++) {
      const snapshot = await getContractWithLatestAnalysisForUser(userId, contract.id);
      const { id } = await createAnalysisForContract({
        userId, contractId: contract.id, expectedRevision: snapshot!.revision, riskBadge: "LOW",
        resultJson: (options.resultJson?.(contract.id) ?? analysisFor(contract.id)) as Record<string, unknown>,
        llmProvider: "test", llmModel: "test",
      });
      analysisIds.push(id);
    }
    return { contract, analysisId: analysisIds.at(-1)!, analysisIds };
  }

  const decision = (analysisId: string, overrides: Partial<ClarifyDecisionInput> = {}): ClarifyDecisionInput => ({
    analysisId,
    itemKey: TERM_KEY,
    state: "accepted",
    reason: "Monthly is fine.",
    itemLabel: "Term: Not specified",
    ...overrides,
  });

  async function stored(contractId: string) {
    return (
      await pool.current!.query(
        `SELECT user_id, item_key, source_revision, analysis_id, state, reason, item_label, updated_at
         FROM clarify_decisions WHERE contract_id = $1 ORDER BY created_at, id`,
        [contractId],
      )
    ).rows;
  }

  it("records migration 025 and applies it to a schema as 024 leaves it, without touching existing rows", async () => {
    const { rows } = await pool.current!.query(
      "SELECT filename FROM schema_migrations WHERE filename = '025_clarify_decisions.sql'",
    );
    expect(rows).toHaveLength(1);

    const migration = await readFile(
      new URL("../db/migrations/025_clarify_decisions.sql", import.meta.url),
      "utf8",
    );
    const client = await pool.current!.connect();
    const schema = `decisions_migration_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      await client.query("CREATE TABLE application_users (id text PRIMARY KEY)");
      await client.query(
        "CREATE TABLE contracts (id uuid PRIMARY KEY, user_id text NOT NULL, title text NOT NULL)",
      );
      await client.query(
        "CREATE TABLE analyses (id uuid PRIMARY KEY, contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE)",
      );
      const contractId = randomUUID();
      const analysisId = randomUUID();
      await client.query("INSERT INTO application_users VALUES ('existing-owner')");
      await client.query("INSERT INTO contracts VALUES ($1, 'existing-owner', 'Existing')", [contractId]);
      await client.query("INSERT INTO analyses VALUES ($1, $2)", [analysisId, contractId]);

      await client.query(migration);

      expect((await client.query("SELECT * FROM contracts")).rows).toEqual([
        { id: contractId, user_id: "existing-owner", title: "Existing" },
      ]);
      expect((await client.query("SELECT * FROM analyses")).rows).toEqual([
        { id: analysisId, contract_id: contractId },
      ]);
      expect((await client.query(`SELECT * FROM ${schema}.clarify_decisions`)).rows).toEqual([]);
      const inserted = await client.query(
        `INSERT INTO ${schema}.clarify_decisions(contract_id, user_id, item_key, source_revision, analysis_id, state, item_label)
         VALUES ($1, 'existing-owner', $2, $3, $4, 'open', 'Term') RETURNING reason, id`,
        [contractId, TERM_KEY, REVISION, analysisId],
      );
      expect(inserted.rows[0]).toMatchObject({ reason: "", id: expect.any(String) });
      await client.query("DELETE FROM analyses WHERE id = $1", [analysisId]);
      expect((await client.query(`SELECT analysis_id FROM ${schema}.clarify_decisions`)).rows).toEqual([
        { analysis_id: null },
      ]);
      await client.query("DELETE FROM contracts WHERE id = $1", [contractId]);
      expect((await client.query(`SELECT * FROM ${schema}.clarify_decisions`)).rows).toEqual([]);
    } finally {
      // Also removes the private schema and its fixtures.
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("checks keys, revisions, states and lengths in the table itself", async () => {
    const userId = await owner();
    const { contract, analysisId } = await analysedContract(userId);
    const insert = (overrides: Record<string, unknown>) => {
      const row = {
        item_key: TERM_KEY, source_revision: REVISION, state: "open", reason: "", item_label: "Term",
        ...overrides,
      };
      return pool.current!.query(
        `INSERT INTO clarify_decisions(contract_id, user_id, analysis_id, item_key, source_revision, state, reason, item_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [contract.id, userId, analysisId, row.item_key, row.source_revision, row.state, row.reason, row.item_label],
      );
    };
    for (const bad of [
      { item_key: "Term" },
      { item_key: `v1:question:${"a".repeat(200)}` },
      { source_revision: "sha256:abc" },
      { state: "ignored" },
      { reason: "a".repeat(2001) },
      { item_label: "" },
      { item_label: "a".repeat(501) },
    ]) {
      await expect(insert(bad), JSON.stringify(bad).slice(0, 80)).rejects.toThrow(/check constraint/);
    }
    // char_length counts code points: 2,000 emoji are 4,000 UTF-16 code units.
    await expect(insert({ reason: "😀".repeat(2000), item_label: "😀".repeat(500) })).resolves.toBeDefined();
    await expect(insert({})).rejects.toThrow(/duplicate key/);
    const { rows } = await pool.current!.query(
      `SELECT extract(microseconds FROM created_at)::bigint % 1000 AS created,
         extract(microseconds FROM updated_at)::bigint % 1000 AS updated
       FROM clarify_decisions WHERE contract_id = $1`,
      [contract.id],
    );
    expect(rows).toEqual([{ created: "0", updated: "0" }]);
  });

  it("lists, saves and deletes decisions for the owner only, leaking nothing to another user", async () => {
    const userId = await owner();
    const intruder = await owner();
    const { contract, analysisId } = await analysedContract(userId);
    const theirs = await analysedContract(intruder);

    expect(await listClarifyDecisionsForUser(userId, contract.id)).toEqual([]);
    expect(await listClarifyDecisionsForUser(intruder, contract.id)).toBeNull();
    expect(await listClarifyDecisionsForUser(userId, randomUUID())).toBeNull();

    // Another user cannot create a decision on the contract, nor use their own analysis on it, nor
    // the owner's analysis on their own contract.
    expect(await saveClarifyDecisionForUser(intruder, contract.id, decision(analysisId), null)).toEqual({ status: "not_found" });
    expect(await saveClarifyDecisionForUser(intruder, contract.id, decision(theirs.analysisId), null)).toEqual({ status: "not_found" });
    expect(await saveClarifyDecisionForUser(intruder, theirs.contract.id, decision(analysisId), null)).toEqual({ status: "not_found" });
    expect(await saveClarifyDecisionForUser(userId, contract.id, decision(randomUUID()), null)).toEqual({ status: "not_found" });
    expect(await saveClarifyDecisionForUser(userId, randomUUID(), decision(analysisId), null)).toEqual({ status: "not_found" });
    expect(await stored(contract.id)).toEqual([]);

    const created = await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId), null);
    expect(created).toMatchObject({
      status: "saved",
      decision: {
        id: expect.any(String), contractId: contract.id, analysisId, itemKey: TERM_KEY,
        sourceRevision: REVISION, state: "accepted", reason: "Monthly is fine.", itemLabel: "Term: Not specified",
      },
    });
    if (created.status !== "saved") throw new Error("expected a save");
    expect(created.decision.createdAt).toEqual(created.decision.updatedAt);
    expect(await listClarifyDecisionsForUser(userId, contract.id)).toEqual([created.decision]);
    expect((await stored(contract.id))[0]).toMatchObject({ user_id: userId });

    // Nor read, overwrite or delete it, whatever revision they claim.
    const current = revision(created.decision);
    expect(await listClarifyDecisionsForUser(intruder, contract.id)).toBeNull();
    expect(await saveClarifyDecisionForUser(intruder, contract.id, decision(analysisId, { state: "open" }), current)).toEqual({ status: "not_found" });
    expect(await deleteClarifyDecisionForUser(intruder, contract.id, created.decision.id, current)).toEqual({ status: "not_found" });
    expect(await deleteClarifyDecisionForUser(intruder, theirs.contract.id, created.decision.id, current)).toEqual({ status: "not_found" });
    expect(await listClarifyDecisionsForUser(userId, contract.id)).toEqual([created.decision]);

    // A decision id under another of the owner's contracts is not found either.
    const other = await createContractForUser({ userId, title: "Other" });
    expect(await deleteClarifyDecisionForUser(userId, other.id, created.decision.id, current)).toEqual({ status: "not_found" });

    expect(await deleteClarifyDecisionForUser(userId, contract.id, created.decision.id, current)).toEqual({ status: "deleted" });
    expect(await listClarifyDecisionsForUser(userId, contract.id)).toEqual([]);
    expect(await deleteClarifyDecisionForUser(userId, contract.id, created.decision.id, current)).toEqual({ status: "not_found" });
  });

  it("stores the analysis's own source revision and refuses analyses without one", async () => {
    const userId = await owner();
    const { contract, analysisId } = await analysedContract(userId);
    const saved = await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId), null);
    expect(saved).toMatchObject({ status: "saved", decision: { sourceRevision: contractSourceRevision(CONTRACT_TEXT) } });
    expect((await stored(contract.id))[0]).toMatchObject({ source_revision: REVISION });

    // An analysis saved before quotations existed, or whose source names another contract.
    const legacy = await analysedContract(userId, {
      resultJson: (contractId) => {
        const result = analysisFor(contractId);
        delete result.source;
        return result;
      },
    });
    expect(await saveClarifyDecisionForUser(userId, legacy.contract.id, decision(legacy.analysisId), null)).toEqual({ status: "no_revision" });
    const foreign = await analysedContract(userId, { resultJson: () => storedAnalysis() });
    expect(await saveClarifyDecisionForUser(userId, foreign.contract.id, decision(foreign.analysisId), null)).toEqual({ status: "no_revision" });
    expect([...(await stored(legacy.contract.id)), ...(await stored(foreign.contract.id))]).toEqual([]);
  });

  it("refuses a key the analysis's checklist does not list, or lists twice, storing nothing", async () => {
    const userId = await owner();
    const { contract, analysisId } = await analysedContract(userId);
    for (const itemKey of [
      questionDecisionKey("Is parking included?"),
      // Renewal is quoted in the fixture, so it is not on the list.
      unstatedDecisionKey("Renewal"),
    ]) {
      expect(await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId, { itemKey }), null)).toEqual({ status: "unknown_item" });
    }

    const twice = await analysedContract(userId, {
      resultJson: (contractId) => {
        const result = analysisFor(contractId);
        result.next_actions = { questions_to_ask: [QUESTION, QUESTION], email_templates: [] };
        return result;
      },
    });
    expect(
      await saveClarifyDecisionForUser(userId, twice.contract.id, decision(twice.analysisId, { itemKey: QUESTION_KEY }), null),
    ).toEqual({ status: "ambiguous_item" });
    expect([...(await stored(contract.id)), ...(await stored(twice.contract.id))]).toEqual([]);

    // The same key is accepted where it names one item.
    expect(
      await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId, { itemKey: QUESTION_KEY, itemLabel: QUESTION }), null),
    ).toMatchObject({ status: "saved", decision: { itemKey: QUESTION_KEY } });
  });

  it("refuses stale and duplicate saves and deletes with the stored decision, changing nothing", async () => {
    const userId = await owner();
    const { contract, analysisId } = await analysedContract(userId);
    const first = await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId), null);
    if (first.status !== "saved") throw new Error("expected a save");

    // A second "first save" for the same (contract, key, revision) from another tab.
    expect(await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId, { state: "open" }), null)).toEqual({
      status: "conflict",
      decision: first.decision,
    });

    // Revisions only move forward, even when the clock has not passed the stored one.
    await pool.current!.query(
      "UPDATE clarify_decisions SET updated_at = updated_at + interval '1 hour' WHERE contract_id = $1",
      [contract.id],
    );
    const [ahead] = (await listClarifyDecisionsForUser(userId, contract.id))!;
    const second = await saveClarifyDecisionForUser(
      userId, contract.id, decision(analysisId, { state: "resolved", reason: "They confirmed by email." }), revision(ahead!),
    );
    if (second.status !== "saved") throw new Error("expected a save");
    expect(new Date(second.decision.updatedAt).getTime() - new Date(ahead!.updatedAt).getTime()).toBe(1);
    expect(second.decision).toMatchObject({ id: first.decision.id, state: "resolved", createdAt: first.decision.createdAt });

    const before = await stored(contract.id);
    for (const stale of [revision(first.decision), "2000-01-01T00:00:00.000Z"]) {
      expect(await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId, { state: "open" }), stale)).toEqual({
        status: "conflict",
        decision: second.decision,
      });
      expect(await deleteClarifyDecisionForUser(userId, contract.id, first.decision.id, stale)).toEqual({
        status: "conflict",
        decision: second.decision,
      });
    }
    expect(await stored(contract.id)).toEqual(before);

    // An update of a decision never saved is stale too, and creates nothing.
    expect(
      await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId, { itemKey: QUESTION_KEY, itemLabel: QUESTION }), revision(second.decision)),
    ).toEqual({ status: "conflict", decision: null });
    expect(await stored(contract.id)).toEqual(before);
  });

  it("lets exactly one of two concurrent saves from the same revision win", async () => {
    const userId = await owner();
    const { contract, analysisId } = await analysedContract(userId);

    const firsts = await Promise.all(
      (["open", "accepted"] as const).map((state) =>
        saveClarifyDecisionForUser(userId, contract.id, decision(analysisId, { state }), null),
      ),
    );
    expect(firsts.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const winner = firsts.find((result) => result.status === "saved")!;
    if (winner.status !== "saved") throw new Error("expected a save");

    const updates = await Promise.all(
      (["resolved", "open"] as const).map((state) =>
        saveClarifyDecisionForUser(userId, contract.id, decision(analysisId, { state }), revision(winner.decision)),
      ),
    );
    expect(updates.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const saved = updates.find((result) => result.status === "saved")!;
    expect(await listClarifyDecisionsForUser(userId, contract.id)).toEqual(
      saved.status === "saved" ? [saved.decision] : null,
    );
  });

  it("keeps a decision when its analysis is replaced or deleted, and deletes it with the contract", async () => {
    const userId = await owner();
    const { contract, analysisIds } = await analysedContract(userId, { times: 2 });
    const [older, latest] = analysisIds as [string, string];
    const onOlder = await saveClarifyDecisionForUser(userId, contract.id, decision(older), null);
    if (onOlder.status !== "saved") throw new Error("expected a save");
    // A later save from the latest analysis of the same text moves the decision to it.
    const question = await saveClarifyDecisionForUser(
      userId, contract.id, decision(latest, { itemKey: QUESTION_KEY, itemLabel: QUESTION, state: "open" }), null,
    );
    if (question.status !== "saved") throw new Error("expected a save");

    expect(await deleteAnalysisForContract({ userId, contractId: contract.id, keepAnalysisId: latest })).toBe(true);
    const listed = await listClarifyDecisionsForUser(userId, contract.id);
    expect(byId(listed)).toEqual(byId([{ ...onOlder.decision, analysisId: null }, question.decision]));

    // It can still be updated from the latest analysis and deleted while it only lives under "earlier".
    const moved = await saveClarifyDecisionForUser(userId, contract.id, decision(latest, { state: "resolved" }), revision(onOlder.decision));
    expect(moved).toMatchObject({ status: "saved", decision: { analysisId: latest, state: "resolved" } });

    expect(await deleteAnalysisForContract({ userId, contractId: contract.id, analysisId: latest })).toBe(true);
    expect((await stored(contract.id)).map((row) => row.analysis_id)).toEqual([null, null]);

    expect(await deleteContractForUser({ userId, contractId: contract.id })).toEqual({ deleted: true });
    expect(await stored(contract.id)).toEqual([]);
  });

  it("deletes all of an account's decisions, leaves other accounts' decisions, and blocks saves afterwards", async () => {
    const deleted = await owner();
    const kept = await owner();
    const gone = await analysedContract(deleted);
    expect(await saveClarifyDecisionForUser(deleted, gone.contract.id, decision(gone.analysisId), null)).toMatchObject({ status: "saved" });
    const staying = await analysedContract(kept);
    expect(await saveClarifyDecisionForUser(kept, staying.contract.id, decision(staying.analysisId), null)).toMatchObject({ status: "saved" });

    await deleteAccountForUser(deleted, { keepLogin: true });
    const remaining = await pool.current!.query(
      "SELECT count(*)::integer AS count FROM clarify_decisions WHERE user_id = $1", [deleted],
    );
    expect(remaining.rows[0].count).toBe(0);
    await deleteAccountForUser(deleted);
    expect(await saveClarifyDecisionForUser(deleted, gone.contract.id, decision(gone.analysisId), null)).toEqual({ status: "not_found" });
    expect(await listClarifyDecisionsForUser(kept, staying.contract.id)).toHaveLength(1);
  });

  it("exports each contract's decisions under that contract, and no other account's", async () => {
    const userId = await owner();
    const other = await owner();
    const { contract, analysisId } = await analysedContract(userId);
    const bare = await createContractForUser({ userId, title: "Bare" });
    const term = await saveClarifyDecisionForUser(userId, contract.id, decision(analysisId), null);
    const question = await saveClarifyDecisionForUser(
      userId, contract.id, decision(analysisId, { itemKey: QUESTION_KEY, itemLabel: QUESTION, state: "open", reason: "Ask at signing." }), null,
    );
    if (term.status !== "saved" || question.status !== "saved") throw new Error("expected saves");
    const theirs = await analysedContract(other);
    await saveClarifyDecisionForUser(other, theirs.contract.id, decision(theirs.analysisId, { reason: "Not yours" }), null);

    const data = await getAccountExportForUser(userId);
    expect(byId(data.clarifyDecisions)).toEqual(byId([term.decision, question.decision]));
    expect(JSON.stringify(data)).not.toContain("Not yours");

    const entries = await unzip(createAccountExport({ userId, data, exportedAt: new Date() }));
    const contracts = json(entries, "signloop-export/contracts.json") as Array<{ id: string; decisions: unknown[] }>;
    const strip = ({ contractId: _contractId, ...rest }: typeof term.decision) => ({
      ...rest,
      createdAt: new Date(rest.createdAt).toISOString(),
      updatedAt: new Date(rest.updatedAt).toISOString(),
    });
    expect(contracts.map((row) => [row.id, byId(row.decisions as Array<{ id: string }>)])).toEqual([
      [contract.id, byId([strip(term.decision), strip(question.decision)])],
      [bare.id, []],
    ]);
    expect(entries.get("signloop-export/README.txt")!.toString()).toContain('"Before you sign" items');
  });
});
