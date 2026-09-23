import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
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
  claimChatAdmission,
  claimStorageDeletions,
  deferStorageDeletion,
  completeStorageDeletion,
  createUploadCleanupIntent,
  getContractWindowForUser,
  upsertUserSettings,
  getUserSettingsByUserId,
  appendChatMessagesToThread,
  claimGenerationOperation,
  createAnalysisForContract,
  createChatThreadForUser,
  createContractForUser,
  createProjectForUser,
  deleteAnalysisForContract,
  deleteContractForUser,
  deleteProjectForUser,
  getChatImageForUser,
  getChatThreadByIdForUser,
  getContractAnalysisGateForUser,
  getContractTextForUser,
  getContractWithLatestAnalysisForUser,
  getProjectContextForAnalysis,
  listProjectContextDocumentsForUser,
  getRecentChatMessagesForThreadForUser,
  listContractsByUserId,
  listContractsForChat,
  saveContractUploadForUser,
} from "./server-db";
import { buildAnalysisPrompt } from "./analysis";

describe.skipIf(!connectionString)("database integration", () => {
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
    process.env.SKIP_SCHEMA_BOOTSTRAP = "1";
  });
  afterAll(async () => {
    await pool.current?.end();
    delete process.env.SKIP_SCHEMA_BOOTSTRAP;
  });

  const contract = () =>
    createContractForUser({ userId: "owner", title: "Test" });
  const result = { risk_badge: "LOW", key_points: ["Example"] };
  async function analyse(id: string) {
    const snapshot = await getContractWithLatestAnalysisForUser("owner", id);
    return createAnalysisForContract({
      userId: "owner",
      contractId: id,
      expectedRevision: snapshot!.revision,
      riskBadge: "LOW",
      resultJson: result,
      llmProvider: "test",
      llmModel: "test",
    });
  }

  it("persists and reloads bounded agent tool exchanges in message metadata", async () => {
    const thread = await createChatThreadForUser({
      userId: "owner",
      title: "Agent",
    });
    const agentMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call1",
            toolName: "search_web",
            input: { query: "rates" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "search_web",
            output: { type: "json", value: { brief: "Evidence" } },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Answer [1]" }] },
    ];
    const webSources = [{ title: "Source", url: "https://source.test" }];
    await appendChatMessagesToThread({
      userId: "owner",
      threadId: thread.id,
      messages: [
        { role: "user", content: "Research rates" },
        {
          role: "assistant",
          content: "Answer [1]",
          metadata: {
            agentMessages,
            webSources,
            toolActivity: [{ id: "call1", query: "rates", status: "complete" }],
          },
        },
      ],
    });
    // Assert the round-trip on the read that actually consumes the transcript. The thread-detail
    // read deliberately omits it: its response drops replay state, so hydrating it there was pure
    // cost. Detail still has to carry the rendered fields and enforce ownership.
    const replayed = await getRecentChatMessagesForThreadForUser(
      "owner",
      thread.id,
      10,
    );
    expect(replayed?.at(-1)?.agentMessages).toEqual(agentMessages);
    expect(replayed?.at(-1)?.webSources).toEqual(webSources);
    expect(
      await getRecentChatMessagesForThreadForUser(
        "another-user",
        thread.id,
        10,
      ),
    ).toBeNull();

    const loaded = await getChatThreadByIdForUser("owner", thread.id);
    expect(loaded?.messages.at(-1)?.agentMessages).toBeUndefined();
    expect(loaded?.messages.at(-1)?.toolActivity).toEqual([
      { id: "call1", query: "rates", status: "complete" },
    ]);
    expect(
      await getChatThreadByIdForUser("another-user", thread.id),
    ).toBeNull();
  });

  it("applies every discovered migration, including indexes and referential constraints", async () => {
    const { rows } = await pool.current!.query(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(rows.map((row) => row.filename)).toContain(
      "011_fix_index_coverage.sql",
    );
    // The suite runs runMigrations twice, so this also covers re-run idempotency: 015 must add its
    // indexes and 009-011 must not resurrect the ones they dropped.
    const indexes = await pool.current!.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const indexNames = indexes.rows.map((row) => row.indexname);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "contracts_user_id_updated_at_idx",
        "storage_deletions_created_at_idx",
        "contracts_user_id_created_at_idx",
        "chat_threads_user_id_updated_at_idx",
      ]),
    );
    expect(indexNames).not.toContain("contracts_user_id_idx");
    expect(indexNames).not.toContain("chat_threads_user_id_idx");
    const constraints = await pool.current!.query(
      "SELECT convalidated FROM pg_constraint WHERE conname LIKE '%_fk'",
    );
    expect(constraints.rows).toHaveLength(5);
    expect(constraints.rows.every((row) => row.convalidated)).toBe(true);
  });

  it("answers an analysis cache check without the contract text or result body", async () => {
    const item = await contract();
    expect(await getContractAnalysisGateForUser("owner", item.id)).toEqual({
      status: "DRAFT",
      hasText: false,
      latestAnalysisId: null,
    });
    expect(
      await getContractAnalysisGateForUser("intruder", item.id),
    ).toBeNull();

    await pool.current!.query(
      "UPDATE contracts SET text_content = $2 WHERE id = $1",
      [item.id, `${" ".repeat(20)}Clause text`],
    );
    const created = await analyse(item.id);
    expect(await getContractAnalysisGateForUser("owner", item.id)).toEqual({
      status: "ANALYZED",
      hasText: true,
      latestAnalysisId: created.id,
    });
  });

  it("serializes concurrent analysis deletes and resets status", async () => {
    const item = await contract();
    const first = await analyse(item.id);
    const second = await analyse(item.id);
    expect(
      await Promise.all(
        [first, second].map((analysis) =>
          deleteAnalysisForContract({
            userId: "owner",
            contractId: item.id,
            analysisId: analysis.id,
          }),
        ),
      ),
    ).toEqual([true, true]);
    expect(
      (await getContractWithLatestAnalysisForUser("owner", item.id))?.status,
    ).toBe("DRAFT");
  });

  it("cascades an analysis committed while project deletion waits on its contract", async () => {
    const project = await createProjectForUser({
      userId: "owner",
      title: "Race",
    });
    const item = await createContractForUser({
      userId: "owner",
      title: "Child",
      projectId: project.id,
    });
    const writer = await pool.current!.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM contracts WHERE id = $1 FOR UPDATE", [
        item.id,
      ]);
      const deleting = deleteProjectForUser({
        userId: "owner",
        projectId: project.id,
      });
      await writer.query(
        "INSERT INTO analyses(contract_id, result_json) VALUES ($1, '{}')",
        [item.id],
      );
      await writer.query("COMMIT");
      expect(await deleting).toEqual({ deleted: true });
      expect(
        (
          await pool.current!.query(
            "SELECT id FROM analyses WHERE contract_id = $1",
            [item.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });

  it("queues all uploaded objects in the same transaction as cascade deletion", async () => {
    const item = await contract();
    await saveContractUploadForUser({
      userId: "owner",
      contractId: item.id,
      projectId: null,
      title: "Test",
      fileName: "test.txt",
      text: "Evidence",
      storageKey: "uploads/test",
      bucket: "local",
      contentType: "text/plain",
      sizeBytes: 8,
      extractionMethod: "plain_text",
      extractionConfidence: null,
    });
    expect(
      await deleteContractForUser({ userId: "intruder", contractId: item.id }),
    ).toEqual({ deleted: false });
    expect(
      await deleteContractForUser({ userId: "owner", contractId: item.id }),
    ).toEqual({ deleted: true });
    expect(
      (
        await pool.current!.query(
          "SELECT storage_key FROM storage_deletions WHERE storage_key = 'uploads/test'",
        )
      ).rowCount,
    ).toBe(1);
  });

  it("bounds context excerpts to the prompt's own per-document budget", async () => {
    const project = await createProjectForUser({
      userId: "owner",
      title: "Budget",
    });
    // Distinct head/tail sentinels so a wrong slice direction can't pass by coincidence.
    const long = `HEAD_SENTINEL${"a".repeat(20_000)}TAIL_SENTINEL`;
    await pool.current!.query(
      "INSERT INTO context_documents(project_id, title, extracted_text) VALUES ($1, 'Long', $2), ($1, 'Short', 'Brief evidence')",
      [project.id, long],
    );

    const rows = await getProjectContextForAnalysis("owner", project.id);
    const excerpt = rows.find((row) => row.title === "Long")!;
    // Exactly the budget, marker included -- one character over and buildAnalysisPrompt would
    // trim it a second time and stack a second marker on the same gap.
    expect(excerpt.extractedText).toHaveLength(3_000);
    expect(excerpt.extractedText.startsWith("HEAD_SENTINEL")).toBe(true);
    expect(excerpt.extractedText.endsWith("TAIL_SENTINEL")).toBe(true);
    expect(excerpt.originalCharacterCount).toBe(long.length);
    // Short documents pass through untouched.
    expect(rows.find((row) => row.title === "Short")?.extractedText).toBe(
      "Brief evidence",
    );

    const { prompt } = buildAnalysisPrompt(
      "Contract body",
      undefined,
      rows.map((row) => ({
        title: row.title,
        documentType: row.documentType,
        text: row.extractedText,
        originalCharacterCount: row.originalCharacterCount,
      })),
    );
    expect(
      prompt.split("[Context excerpt omitted from the middle]"),
    ).toHaveLength(2);
    expect(prompt).not.toContain(
      "omitted from the middle of project context document",
    );

    expect(await getProjectContextForAnalysis("intruder", project.id)).toEqual(
      [],
    );
  });

  it("prioritizes recent context in project pages and analysis prompts", async () => {
    const project = await createProjectForUser({ userId: "owner", title: "Recent context" });
    await pool.current!.query(
      `INSERT INTO context_documents(project_id, title, extracted_text, created_at)
       SELECT $1, 'Evidence ' || n, 'Text ' || n,
         now() + n * interval '1 second'
       FROM generate_series(1, 10) AS n`,
      [project.id],
    );

    const listed = await listProjectContextDocumentsForUser("owner", project.id);
    expect(listed.map((row) => row.title)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Evidence ${10 - index}`),
    );

    const context = await getProjectContextForAnalysis("owner", project.id);
    expect(context).toHaveLength(9);
    expect(context[0]?.title).toBe("Evidence 10");
    const { prompt } = buildAnalysisPrompt(
      "Contract body",
      undefined,
      context.map((row) => ({
        title: row.title,
        documentType: row.documentType,
        text: row.extractedText,
        originalCharacterCount: row.originalCharacterCount,
      })),
    );
    expect(prompt).toContain("Title: Evidence 10\n");
    expect(prompt).toContain("Title: Evidence 3\n");
    expect(prompt).not.toContain("Title: Evidence 2\n");
    expect(prompt).not.toContain("Title: Evidence 1\n");
  });

  it("invalidates current and in-flight analyses when project evidence changes", async () => {
    const project = await createProjectForUser({
      userId: "owner",
      title: "Evidence",
    });
    const item = await createContractForUser({
      userId: "owner",
      title: "Child",
      projectId: project.id,
    });
    await analyse(item.id);
    const before = await getContractWithLatestAnalysisForUser("owner", item.id);
    await pool.current!.query(
      "INSERT INTO context_documents(project_id, title, extracted_text) VALUES ($1, 'Changed context', 'New evidence')",
      [project.id],
    );
    const after = await getContractWithLatestAnalysisForUser("owner", item.id);
    expect(after?.status).toBe("DRAFT");
    expect(after?.revision).not.toBe(before?.revision);
    await expect(
      createAnalysisForContract({
        userId: "owner",
        contractId: item.id,
        expectedRevision: before!.revision,
        riskBadge: "LOW",
        resultJson: result,
        llmProvider: "test",
        llmModel: "test",
      }),
    ).rejects.toThrow(/changed/i);
  });

  it("admits only one overlapping operation and permits retry after release", async () => {
    const item = await contract();
    const leases = await Promise.all(
      Array.from({ length: 4 }, () =>
        claimGenerationOperation("owner", "contract", item.id, 60),
      ),
    );
    expect(leases.filter(Boolean)).toHaveLength(1);
    await leases.find(Boolean)!();
    const retry = await claimGenerationOperation(
      "owner",
      "contract",
      item.id,
      60,
    );
    expect(retry).not.toBeNull();
    await retry!();
  });

  it("pages canonical messages and stores images outside transcript text", async () => {
    const thread = await createChatThreadForUser({
      userId: "owner",
      title: "History",
    });
    const png = Buffer.from("test image").toString("base64");
    const added = await appendChatMessagesToThread({
      userId: "owner",
      threadId: thread.id,
      messages: [
        ...Array.from({ length: 60 }, (_, index) => ({
          role: "user" as const,
          content: `Message ${index}`,
        })),
        {
          role: "assistant",
          content: `![Generated image](data:image/png;base64,${png})`,
        },
      ],
    });
    const latest = await getChatThreadByIdForUser("owner", thread.id);
    expect(latest?.messages).toHaveLength(50);
    expect(latest?.hasMore).toBe(true);
    const older = await getChatThreadByIdForUser(
      "owner",
      thread.id,
      latest!.messages[0]!.position,
    );
    expect(older?.messages).toHaveLength(11);
    expect(older?.hasMore).toBe(false);
    const imageId = added.at(-1)!.content.match(/images\/([a-f0-9-]+)/)![1]!;
    expect(
      (await getChatImageForUser("owner", thread.id, imageId))?.toString(),
    ).toBe("test image");
    expect(
      await getChatImageForUser("intruder", thread.id, imageId),
    ).toBeNull();
    expect(await getChatThreadByIdForUser("intruder", thread.id)).toBeNull();
  });

  it("filters standalone contracts before pagination", async () => {
    const project = await createProjectForUser({
      userId: "scope-user",
      title: "Project",
    });
    const standalone = await createContractForUser({
      userId: "scope-user",
      title: "Standalone",
    });
    await createContractForUser({
      userId: "scope-user",
      title: "Newer project contract",
      projectId: project.id,
    });
    expect(
      (await listContractsByUserId("scope-user", { limit: 1 }, true)).data[0]
        ?.id,
    ).toBe(standalone.id);
  });

  it("exposes contract text to chat tools for the owner only", async () => {
    const created = await createContractForUser({
      userId: "chat-owner",
      title: "NDA",
    });
    await pool.current!.query(
      "update contracts set text_content = $1 where id = $2",
      ["Clause 1. Confidential.", created.id],
    );
    expect(
      (await listContractsForChat("chat-owner")).contracts.map((row) => [
        row.id,
        row.title,
        row.characterCount,
      ]),
    ).toEqual([[created.id, "NDA", 23]]);
    expect((await getContractTextForUser("chat-owner", created.id))?.text).toBe(
      "Clause 1. Confidential.",
    );
    expect(await getContractTextForUser("intruder", created.id)).toBeNull();
    expect(await listContractsForChat("intruder")).toEqual({
      contracts: [],
      nextOffset: null,
    });
  });

  it("discovers contracts beyond 50 and searches all titles within the owner scope", async () => {
    const userId = "chat-pagination-owner";
    const oldest = await createContractForUser({
      userId,
      title: "Legacy 100%_NDA",
    });
    for (let index = 0; index < 50; index++) {
      await createContractForUser({ userId, title: `Recent ${index}` });
    }
    await pool.current!.query(
      "update contracts set updated_at = '2020-01-01' where id = $1",
      [oldest.id],
    );
    const first = await listContractsForChat(userId);
    expect(first.contracts).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    expect(first.contracts.some(({ id }) => id === oldest.id)).toBe(false);
    const second = await listContractsForChat(userId, {
      offset: first.nextOffset!,
    });
    expect(second.contracts.map(({ id }) => id)).toEqual([oldest.id]);
    expect(second.nextOffset).toBeNull();
    const found = await listContractsForChat(userId, { query: "100%_nda" });
    expect(found.contracts.map(({ id }) => id)).toEqual([oldest.id]);
    expect(
      await listContractsForChat("intruder", { query: "100%_nda" }),
    ).toEqual({ contracts: [], nextOffset: null });
  });

  it("moves inline images out of mixed prose replies into attachments", async () => {
    const thread = await createChatThreadForUser({
      userId: "owner",
      title: "Images",
    });
    const png = Buffer.from("tool image").toString("base64");
    const [, stored] = await appendChatMessagesToThread({
      userId: "owner",
      threadId: thread.id,
      messages: [
        { role: "user", content: "Draw it" },
        {
          role: "assistant",
          content: `![Generated image](data:image/png;base64,${png})\n\nHere is the diagram you asked for.`,
        },
      ],
    });
    expect(stored!.content).toMatch(
      /^!\[Generated image\]\(\/api\/chat\/threads\/[a-f0-9-]+\/images\/[a-f0-9-]+\)\n\nHere is the diagram you asked for\.$/,
    );
    const imageId = stored!.content.match(/images\/([a-f0-9-]+)/)![1]!;
    expect(
      (await getChatImageForUser("owner", thread.id, imageId))?.toString(),
    ).toBe("tool image");
    expect(
      (await getChatThreadByIdForUser("owner", thread.id))?.messages.at(-1)
        ?.content,
    ).toBe(stored!.content);
  });
  it("enforces shared admission atomically and retains hourly usage after release", async () => {
    await pool.current!.query("TRUNCATE chat_admissions, chat_request_budgets");
    const input = {
      principal: "anonymous",
      hourlyLimit: 2,
      concurrency: 1,
      globalDailyLimit: 10,
      globalConcurrency: 8,
    };
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimChatAdmission(input)),
    );
    const accepted = claims.filter((c) => "release" in c);
    expect(accepted).toHaveLength(1);
    expect(claims.filter((c) => "retryAfter" in c)).toHaveLength(4);
    await accepted[0]!.release();
    const second = await claimChatAdmission(input);
    expect(second).toHaveProperty("release");
    if ("release" in second) await second.release();
    expect(await claimChatAdmission(input)).toEqual({ retryAfter: 3600 });
  });

  it("enforces global concurrency and daily limits across different principals", async () => {
    await pool.current!.query("TRUNCATE chat_admissions, chat_request_budgets");
    const input = {
      hourlyLimit: 10,
      concurrency: 2,
      globalDailyLimit: 2,
      globalConcurrency: 1,
    };
    const first = await claimChatAdmission({ ...input, principal: "one" });
    expect(await claimChatAdmission({ ...input, principal: "two" })).toEqual({
      retryAfter: 30,
    });
    if ("release" in first) await first.release();
    const second = await claimChatAdmission({ ...input, principal: "two" });
    if ("release" in second) await second.release();
    expect(await claimChatAdmission({ ...input, principal: "three" })).toEqual({
      retryAfter: 86400,
    });
  });

  it("expires abandoned admission without letting stale release cancel a new claim", async () => {
    await pool.current!.query("TRUNCATE chat_admissions, chat_request_budgets");
    const input = {
      principal: "expired",
      hourlyLimit: 10,
      concurrency: 1,
      globalDailyLimit: 20,
      globalConcurrency: 2,
    };
    const old = await claimChatAdmission(input);
    await pool.current!.query(
      "UPDATE chat_admissions SET expires_at = now() - interval '1 second'",
    );
    const next = await claimChatAdmission(input);
    if ("release" in old) await old.release();
    expect(
      (await pool.current!.query("SELECT * FROM chat_admissions")).rowCount,
    ).toBe(1);
    if ("release" in next) await next.release();
  });

  it("claims deletion rows exclusively, defers failures, and rejects stale acknowledgments", async () => {
    await pool.current!.query("TRUNCATE storage_deletions");
    await pool.current!.query(
      "INSERT INTO storage_deletions(storage_key) SELECT 'test-' || n FROM generate_series(1,5) n",
    );
    const batches = await Promise.all([
      claimStorageDeletions(3),
      claimStorageDeletions(3),
    ]);
    const claimed = batches.flat();
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed.map((r) => r.id)).size).toBe(5);
    expect(await claimStorageDeletions()).toEqual([]);
    const failed = claimed[0]!;
    await deferStorageDeletion(failed.id, failed.token);
    const state = (
      await pool.current!.query(
        "SELECT attempts, available_at > now() AS deferred FROM storage_deletions WHERE id = $1",
        [failed.id],
      )
    ).rows[0];
    expect(state).toEqual({ attempts: 1, deferred: true });
    await pool.current!.query(
      "UPDATE storage_deletions SET available_at = now() - interval '1 second' WHERE id = $1",
      [failed.id],
    );
    const retry = (await claimStorageDeletions())[0]!;
    expect(retry.id).toBe(failed.id);
    await completeStorageDeletion(failed.id, failed.token);
    expect(
      (
        await pool.current!.query(
          "SELECT id FROM storage_deletions WHERE id = $1",
          [failed.id],
        )
      ).rowCount,
    ).toBe(1);
    await completeStorageDeletion(retry.id, retry.token);
    expect(
      (
        await pool.current!.query(
          "SELECT id FROM storage_deletions WHERE id = $1",
          [failed.id],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("consumes upload intents with persistence and rolls back writes if cleanup already claimed them", async () => {
    await pool.current!.query("TRUNCATE storage_deletions");
    const item = await contract();
    const input = {
      userId: "owner",
      contractId: item.id,
      projectId: null,
      title: "Intent",
      fileName: "test.txt",
      storageKey: "uploads/intent",
      bucket: "local",
      contentType: "text/plain",
      sizeBytes: 5,
      text: "saved",
      extractionMethod: "plain_text",
      extractionConfidence: 100,
    };
    const intent = await createUploadCleanupIntent(input.storageKey);
    expect(await claimStorageDeletions()).toEqual([]);
    expect(
      await saveContractUploadForUser({ ...input, storageIntentId: intent }),
    ).toBe(true);
    expect(
      (
        await pool.current!.query(
          "SELECT id FROM storage_deletions WHERE id = $1",
          [intent],
        )
      ).rowCount,
    ).toBe(0);
    const conflicted = await createUploadCleanupIntent("uploads/conflict");
    await pool.current!.query(
      "UPDATE storage_deletions SET available_at = now() WHERE id = $1",
      [conflicted],
    );
    await claimStorageDeletions();
    await expect(
      saveContractUploadForUser({
        ...input,
        text: "must rollback",
        storageKey: "uploads/conflict",
        storageIntentId: conflicted,
      }),
    ).rejects.toThrow(/cleanup/);
    expect((await getContractTextForUser("owner", item.id))?.text).toBe(
      "saved",
    );
    expect(
      (
        await pool.current!.query(
          "SELECT id FROM contract_files WHERE storage_key = 'uploads/conflict'",
        )
      ).rowCount,
    ).toBe(0);
  });

  it("uses code point offsets for SQL windows without splitting supplementary characters", async () => {
    const item = await contract();
    await pool.current!.query(
      "UPDATE contracts SET text_content = repeat('😀', 12000) || 'tail' WHERE id = $1",
      [item.id],
    );
    const first = await getContractWindowForUser("owner", item.id, 0);
    expect(first?.characterCount).toBe(12004);
    expect(first?.text).toBe("😀".repeat(12000));
    expect(
      (await getContractWindowForUser("owner", item.id, 12000))?.text,
    ).toBe("tail");
    expect(await getContractWindowForUser("intruder", item.id, 0)).toBeNull();
  });

  it("atomic setting patches preserve fields omitted by concurrent callers", async () => {
    await Promise.all([
      upsertUserSettings({
        userId: "settings-owner",
        primaryModel: "model-test",
      }),
      upsertUserSettings({
        userId: "settings-owner",
        personality: "signloop-assistant",
      }),
    ]);
    expect(await getUserSettingsByUserId("settings-owner")).toMatchObject({
      primaryModel: "model-test",
      personality: "signloop-assistant",
    });
  });
});
