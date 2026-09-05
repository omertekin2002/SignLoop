import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../db/migrations.js";

// Opt in only against the disposable database created by db/test-integration.sh.
const connectionString = process.env.SIGNLOOP_TEST_DATABASE_URL;
const { pool } = vi.hoisted(() => ({ pool: { current: null as Pool | null } }));
vi.mock("@vercel/postgres", () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => pool.current!.query(strings.reduce((query, part, index) => query + (index ? `$${index}` : "") + part, ""), values),
    { query: (text: string, values?: unknown[]) => pool.current!.query(text, values), connect: () => pool.current!.connect() },
  );
  return { sql };
});

import {
  appendChatMessagesToThread, claimGenerationOperation, createAnalysisForContract,
  createChatThreadForUser, createContractForUser, createProjectForUser,
  deleteAnalysisForContract, deleteContractForUser, deleteProjectForUser,
  getChatImageForUser, getChatThreadByIdForUser, getContractWithLatestAnalysisForUser,
  listContractsByUserId, saveContractUploadForUser,
} from "./server-db";

describe.skipIf(!connectionString)("database integration", () => {
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (url.hostname !== "localhost" || url.pathname !== "/signloop_test") throw new Error("Integration tests require the disposable local signloop_test database");
    pool.current = new Pool({ connectionString, max: 8 });
    const client = await pool.current.connect();
    try { await runMigrations(client); await runMigrations(client); } finally { client.release(); }
    process.env.SKIP_SCHEMA_BOOTSTRAP = "1";
  });
  afterAll(async () => { await pool.current?.end(); delete process.env.SKIP_SCHEMA_BOOTSTRAP; });

  const contract = () => createContractForUser({ userId: "owner", title: "Test" });
  const result = { risk_badge: "LOW", key_points: ["Example"] };
  async function analyse(id: string) {
    const snapshot = await getContractWithLatestAnalysisForUser("owner", id);
    return createAnalysisForContract({ userId: "owner", contractId: id, expectedRevision: snapshot!.revision, riskBadge: "LOW", resultJson: result, llmProvider: "test", llmModel: "test" });
  }

  it("applies every discovered migration, including indexes and referential constraints", async () => {
    const { rows } = await pool.current!.query("SELECT filename FROM schema_migrations ORDER BY filename");
    expect(rows.map((row) => row.filename)).toContain("011_fix_index_coverage.sql");
    const constraints = await pool.current!.query("SELECT convalidated FROM pg_constraint WHERE conname LIKE '%_fk'");
    expect(constraints.rows).toHaveLength(5);
    expect(constraints.rows.every((row) => row.convalidated)).toBe(true);
  });

  it("serializes concurrent analysis deletes and resets status", async () => {
    const item = await contract();
    const first = await analyse(item.id); const second = await analyse(item.id);
    expect(await Promise.all([first, second].map((analysis) => deleteAnalysisForContract({ userId: "owner", contractId: item.id, analysisId: analysis.id })))).toEqual([true, true]);
    expect((await getContractWithLatestAnalysisForUser("owner", item.id))?.status).toBe("DRAFT");
  });

  it("cascades an analysis committed while project deletion waits on its contract", async () => {
    const project = await createProjectForUser({ userId: "owner", title: "Race" });
    const item = await createContractForUser({ userId: "owner", title: "Child", projectId: project.id });
    const writer = await pool.current!.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM contracts WHERE id = $1 FOR UPDATE", [item.id]);
      const deleting = deleteProjectForUser({ userId: "owner", projectId: project.id });
      await writer.query("INSERT INTO analyses(contract_id, result_json) VALUES ($1, '{}')", [item.id]);
      await writer.query("COMMIT");
      expect(await deleting).toEqual({ deleted: true });
      expect((await pool.current!.query("SELECT id FROM analyses WHERE contract_id = $1", [item.id])).rowCount).toBe(0);
    } finally { await writer.query("ROLLBACK"); writer.release(); }
  });

  it("queues all uploaded objects in the same transaction as cascade deletion", async () => {
    const item = await contract();
    await saveContractUploadForUser({ userId: "owner", contractId: item.id, projectId: null, title: "Test", fileName: "test.txt", text: "Evidence", storageKey: "uploads/test", bucket: "local", contentType: "text/plain", sizeBytes: 8, extractionMethod: "plain_text", extractionConfidence: null });
    expect(await deleteContractForUser({ userId: "intruder", contractId: item.id })).toEqual({ deleted: false });
    expect(await deleteContractForUser({ userId: "owner", contractId: item.id })).toEqual({ deleted: true });
    expect((await pool.current!.query("SELECT storage_key FROM storage_deletions WHERE storage_key = 'uploads/test'")).rowCount).toBe(1);
  });

  it("invalidates current and in-flight analyses when project evidence changes", async () => {
    const project = await createProjectForUser({ userId: "owner", title: "Evidence" });
    const item = await createContractForUser({ userId: "owner", title: "Child", projectId: project.id });
    await analyse(item.id);
    const before = await getContractWithLatestAnalysisForUser("owner", item.id);
    await pool.current!.query("INSERT INTO context_documents(project_id, title, extracted_text) VALUES ($1, 'Changed context', 'New evidence')", [project.id]);
    const after = await getContractWithLatestAnalysisForUser("owner", item.id);
    expect(after?.status).toBe("DRAFT"); expect(after?.revision).not.toBe(before?.revision);
    await expect(createAnalysisForContract({ userId: "owner", contractId: item.id, expectedRevision: before!.revision, riskBadge: "LOW", resultJson: result, llmProvider: "test", llmModel: "test" })).rejects.toThrow(/changed/i);
  });

  it("admits only one overlapping operation and permits retry after release", async () => {
    const item = await contract();
    const leases = await Promise.all(Array.from({ length: 4 }, () => claimGenerationOperation("owner", "contract", item.id, 60)));
    expect(leases.filter(Boolean)).toHaveLength(1);
    await leases.find(Boolean)!();
    const retry = await claimGenerationOperation("owner", "contract", item.id, 60);
    expect(retry).not.toBeNull(); await retry!();
  });

  it("pages canonical messages and stores images outside transcript text", async () => {
    const thread = await createChatThreadForUser({ userId: "owner", title: "History" });
    const png = Buffer.from("test image").toString("base64");
    const added = await appendChatMessagesToThread({ userId: "owner", threadId: thread.id, messages: [...Array.from({ length: 60 }, (_, index) => ({ role: "user" as const, content: `Message ${index}` })), { role: "assistant", content: `![Generated image](data:image/png;base64,${png})` }] });
    const latest = await getChatThreadByIdForUser("owner", thread.id);
    expect(latest?.messages).toHaveLength(50); expect(latest?.hasMore).toBe(true);
    const older = await getChatThreadByIdForUser("owner", thread.id, latest!.messages[0]!.position);
    expect(older?.messages).toHaveLength(11); expect(older?.hasMore).toBe(false);
    const imageId = added.at(-1)!.content.match(/images\/([a-f0-9-]+)/)![1]!;
    expect((await getChatImageForUser("owner", thread.id, imageId))?.toString()).toBe("test image");
    expect(await getChatImageForUser("intruder", thread.id, imageId)).toBeNull();
    expect(await getChatThreadByIdForUser("intruder", thread.id)).toBeNull();
  });

  it("filters standalone contracts before pagination", async () => {
    const project = await createProjectForUser({ userId: "scope-user", title: "Project" });
    const standalone = await createContractForUser({ userId: "scope-user", title: "Standalone" });
    await createContractForUser({ userId: "scope-user", title: "Newer project contract", projectId: project.id });
    expect((await listContractsByUserId("scope-user", { limit: 1 }, true)).data[0]?.id).toBe(standalone.id);
  });
});
