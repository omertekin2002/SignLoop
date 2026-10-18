import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { STALE_CONTRACT_REPLY, type ContractEvidence } from "./contract-evidence";
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
  getContractSourceForUser,
  getAnalysisForUser,
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
  getContractByIdForUser,
  getContractTextForUser,
  getContractWithLatestAnalysisForUser,
  getProjectByIdForUser,
  getProjectContextForAnalysis,
  listProjectContextDocumentsForUser,
  getRecentChatMessagesForThreadForUser,
  listContractsByUserId,
  listContractsForChat,
  saveContractUploadForUser,
} from "./server-db";
import { attachAnalysisSources, contractSourceRevision } from "./analysis-sources";
import { citationForReport } from "./source-citations";
import { buildAnalysisPrompt } from "./analysis";

// db/test-integration.sh sets this and runs vitest directly, outside turbo's env filtering.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.REQUIRE_DB_TESTS === "1" && !connectionString)
  throw new Error(
    "REQUIRE_DB_TESTS=1 but SIGNLOOP_TEST_DATABASE_URL is unset; refusing to skip the database suite",
  );

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

  it("returns the active text's extraction warning in contract detail, owner-scoped and without the text", async () => {
    const item = await contract();
    const warning =
      "Page 2 has little or no selectable text and was not read; it may be a scanned image. Verify that page in the original before relying on the analysis.";
    const upload = {
      userId: "owner",
      contractId: item.id,
      projectId: null,
      title: "Test",
      fileName: "agreement.pdf",
      storageKey: `extraction-warning-${item.id}`,
      bucket: "test",
      contentType: "application/pdf",
      sizeBytes: 1727,
      extractionMethod: "pdf_parse",
      extractionConfidence: 66,
    };
    await saveContractUploadForUser({
      ...upload,
      text: "Readable clause text.",
      extractionWarning: warning,
    });

    const detail = await getContractByIdForUser("owner", item.id);
    expect(detail).toMatchObject({
      id: item.id,
      status: "DRAFT",
      extractionWarning: warning,
      analyses: [],
      analysesHasMore: false,
    });
    expect(detail).not.toHaveProperty("text");
    expect(await getContractByIdForUser("intruder", item.id)).toBeNull();

    // The warning follows the active text: a clean re-upload clears it.
    await saveContractUploadForUser({
      ...upload,
      storageKey: `${upload.storageKey}-clean`,
      text: "Replacement clause text.",
      extractionWarning: null,
    });
    expect(
      (await getContractByIdForUser("owner", item.id))?.extractionWarning,
    ).toBeNull();
  });

  it("serves bounded source pages with Unicode/hash agreement and owner isolation", async () => {
    const item = await contract();
    const text = "😀e\u0301東京" + "x".repeat(20000) + "TAIL FEE";
    await pool.current!.query(
      "UPDATE contracts SET text_content = $1, extraction_warning = 'Missing scanned pages' WHERE id = $2",
      [text, item.id],
    );
    const revision = contractSourceRevision(text);
    const first = await getContractSourceForUser({
      userId: "owner",
      contractId: item.id,
      offset: 0,
      revision: null,
    });
    expect(first?.revision).toBe(revision);
    expect(first?.totalCharacters).toBe(Array.from(text).length);
    expect(Array.from(first!.text!)).toHaveLength(6000);
    expect(first?.extractionWarning).toBe("Missing scanned pages");
    const second = await getContractSourceForUser({
      userId: "owner",
      contractId: item.id,
      offset: 6000,
      revision,
    });
    expect(second?.text).toBe(Array.from(text).slice(6000, 12000).join(""));
    expect(
      await getContractSourceForUser({
        userId: "intruder",
        contractId: item.id,
        offset: 0,
        revision,
      }),
    ).toBeNull();
    expect(
      (
        await getContractSourceForUser({
          userId: "owner",
          contractId: item.id,
          offset: 0,
          revision: contractSourceRevision("wrong"),
        })
      )?.text,
    ).toBeNull();
  });

  it("preserves JSON receipts through status/context updates but rejects replacement and deleted sources", async () => {
    const project = await createProjectForUser({
      userId: "owner",
      title: "Source test",
    });
    const item = await createContractForUser({
      userId: "owner",
      title: "Source test",
      projectId: project.id,
    });
    const text = "😀 Original fee clause.";
    await pool.current!.query(
      "UPDATE contracts SET text_content = $1 WHERE id = $2",
      [text, item.id],
    );
    const before = await getContractWithLatestAnalysisForUser("owner", item.id);
    const resultJson = attachAnalysisSources(
      {
        red_flags: [
          { evidence: { quote: "Original fee clause.", segment: "full" } },
        ],
      },
      item.id,
      text,
    );
    const saved = await createAnalysisForContract({
      userId: "owner",
      contractId: item.id,
      expectedRevision: before!.revision,
      riskBadge: "LOW",
      resultJson,
      llmProvider: "test",
      llmModel: "test",
    });
    const read = await getAnalysisForUser("owner", item.id, saved.id);
    const citation = citationForReport(read?.resultJson, item.id, 0)!;
    const input = {
      userId: "owner",
      contractId: item.id,
      analysisId: saved.id,
      offset: 0,
      revision: citation.revision,
      citation,
    };
    expect((await getContractSourceForUser(input))?.highlightMatches).toBe(
      true,
    );
    await pool.current!.query(
      "INSERT INTO context_documents(project_id, title, extracted_text) VALUES ($1, 'Changed context', 'context')",
      [project.id],
    );
    expect((await getContractSourceForUser(input))?.highlightMatches).toBe(
      true,
    );
    const snapshot = await getContractWithLatestAnalysisForUser(
      "owner",
      item.id,
    );
    await saveContractUploadForUser({
      userId: "owner",
      contractId: item.id,
      projectId: project.id,
      title: "Replacement",
      fileName: "replacement.txt",
      storageKey: "source-test-replacement",
      bucket: "test",
      contentType: "text/plain",
      sizeBytes: 20,
      extractionMethod: "test",
      extractionConfidence: 1,
      text: "Replacement fee clause.",
    });
    const changed = await getContractSourceForUser(input);
    expect(changed?.text).toBeNull();
    expect(changed?.highlightMatches).toBe(false);
    expect(
      (await getAnalysisForUser("owner", item.id, saved.id))?.resultJson,
    ).toEqual(resultJson);
    await expect(
      createAnalysisForContract({
        userId: "owner",
        contractId: item.id,
        expectedRevision: snapshot!.revision,
        riskBadge: "LOW",
        resultJson,
        llmProvider: "test",
        llmModel: "test",
      }),
    ).rejects.toThrow(/changed/i);
    await deleteContractForUser({ userId: "owner", contractId: item.id });
    expect(await getContractSourceForUser(input)).toBeNull();
    expect(await getAnalysisForUser("owner", item.id, saved.id)).toBeNull();
  });

  it("rechecks report existence and rejects mismatched or omitted-middle spans", async () => {
    const item = await contract();
    const text = "x".repeat(10000) + "MIDDLE" + "x".repeat(10000) + "END";
    await pool.current!.query(
      "UPDATE contracts SET text_content = $1 WHERE id = $2",
      [text, item.id],
    );
    const saved = await analyse(item.id);
    const revision = contractSourceRevision(text);
    const base = {
      userId: "owner",
      contractId: item.id,
      analysisId: saved.id,
      offset: 0,
      revision,
    };
    const citation = {
      contract_id: item.id,
      revision,
      index_unit: "unicode-code-points" as const,
      status: "verified" as const,
      quote: "MIDDLE",
      start: 10000,
      end: 10006,
    };
    expect(
      (await getContractSourceForUser({ ...base, citation }))?.highlightMatches,
    ).toBe(false);
    expect(
      (
        await getContractSourceForUser({
          ...base,
          citation: { ...citation, start: 0, end: 6 },
        })
      )?.highlightMatches,
    ).toBe(false);
    expect(
      (
        await getContractSourceForUser({
          ...base,
          citation: { ...citation, quote: "END", start: 20006, end: 20009 },
        })
      )?.highlightMatches,
    ).toBe(true);
    await deleteAnalysisForContract({
      userId: "owner",
      contractId: item.id,
      analysisId: saved.id,
    });
    expect(await getContractSourceForUser(base)).toBeNull();
    expect(
      (await getContractSourceForUser({ ...base, analysisId: undefined }))
        ?.revision,
    ).toBe(revision);
  });

  it("saves the first generated chat title atomically and preserves it on later turns", async () => {
    const thread = await createChatThreadForUser({ userId: "title-owner" });
    const messages = [
      { role: "user" as const, content: "Explain renewal" },
      { role: "assistant" as const, content: "Renewal extends the term." },
    ];
    await expect(
      appendChatMessagesToThread({
        userId: "intruder",
        threadId: thread.id,
        messages,
        generatedTitle: "Wrong owner",
      }),
    ).rejects.toThrow();
    expect(
      (await getChatThreadByIdForUser("title-owner", thread.id))?.title,
    ).toBe("New chat");

    await appendChatMessagesToThread({
      userId: "title-owner",
      threadId: thread.id,
      messages,
      generatedTitle: "Lease Renewal Terms",
    });
    const saved = await getChatThreadByIdForUser("title-owner", thread.id);
    expect(saved?.title).toBe("Lease Renewal Terms");
    expect(saved?.messages).toHaveLength(2);

    await appendChatMessagesToThread({
      userId: "title-owner",
      threadId: thread.id,
      messages,
      generatedTitle: "Another topic",
    });
    expect(
      (await getChatThreadByIdForUser("title-owner", thread.id))?.title,
    ).toBe("Lease Renewal Terms");
  });

  it("preserves custom titles and saves replies even when title generation failed", async () => {
    const custom = await createChatThreadForUser({
      userId: "owner",
      title: "My contract",
    });
    const untitled = await createChatThreadForUser({ userId: "owner" });
    for (const [thread, generatedTitle] of [
      [custom, "Generated name"],
      [untitled, null],
    ] as const) {
      await appendChatMessagesToThread({
        userId: "owner",
        threadId: thread.id,
        generatedTitle,
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
        ],
      });
      const saved = await getChatThreadByIdForUser("owner", thread.id);
      expect(saved?.title).toBe(thread.title);
      expect(saved?.messages).toHaveLength(2);
    }
    await appendChatMessagesToThread({
      userId: "owner",
      threadId: untitled.id,
      generatedTitle: "Late competing title",
      messages: [{ role: "user", content: "Another turn" }],
    });
    expect((await getChatThreadByIdForUser("owner", untitled.id))?.title).toBe(
      "New chat",
    );
  });

  it("persists and reloads bounded agent tool exchanges in message metadata", async () => {
    const answer = `${"x".repeat(2500)} The renewal deadline is September 30.`;
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
      { role: "assistant", content: [{ type: "text", text: answer }] },
    ];
    const webSources = [{ number: 65, title: "Source", url: "https://source.test" }];
    await appendChatMessagesToThread({
      userId: "owner",
      threadId: thread.id,
      messages: [
        { role: "user", content: "Research rates" },
        {
          role: "assistant",
          content: answer,
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
    expect(replayed?.at(-1)?.agentMessages).toEqual(agentMessages.slice(0, 2));
    expect(replayed?.at(-1)?.content).toBe(answer);
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

  it("resets status when deleting the latest analysis with uppercase UUIDs while older results remain", async () => {
    const item = await contract();
    const older = await analyse(item.id);
    const latest = await analyse(item.id);
    expect(await deleteAnalysisForContract({
      userId: "OWNER",
      contractId: item.id.toUpperCase(),
      analysisId: latest.id.toUpperCase(),
    })).toBe(false);
    expect((await getContractAnalysisGateForUser("owner", item.id))?.status).toBe("ANALYZED");

    expect(await deleteAnalysisForContract({
      userId: "owner",
      contractId: item.id.toUpperCase(),
      analysisId: latest.id.toUpperCase(),
    })).toBe(true);
    expect((await getContractAnalysisGateForUser("owner", item.id))?.status).toBe("DRAFT");
    expect((await pool.current!.query(
      "SELECT id FROM analyses WHERE contract_id = $1",
      [item.id],
    )).rows).toEqual([{ id: older.id }]);
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

  const readContractTurn = (contractId: string, toolCallId: string) => [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "read_contract",
          input: { contractId },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "read_contract",
          output: {
            type: "json",
            value: { id: contractId, content: "Secret clause text" },
          },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Summary" }] },
  ];
  async function saveTurn(userId: string, agentMessages: unknown[], receipts?: ContractEvidence[]) {
    const ids = JSON.stringify(agentMessages).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi) ?? [];
    const contractEvidence = receipts ?? (await pool.current!.query<ContractEvidence>(
      `SELECT id, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS revision FROM contracts WHERE id = ANY($1::uuid[])`, [ids],
    )).rows;
    const thread = await createChatThreadForUser({ userId, title: "Replay" });
    await appendChatMessagesToThread({
      userId,
      threadId: thread.id,
      messages: [
        { role: "user", content: "What does it say?" },
        {
          role: "assistant",
          content: "It quotes the secret clause.",
          metadata: {
            agentMessages,
            contractEvidence,
            toolActivity: [
              { id: "call", query: "contract", status: "complete" },
            ],
          },
        },
      ],
    });
    return async () =>
      (await getRecentChatMessagesForThreadForUser(userId, thread.id, 10))?.at(
        -1,
      );
  }

  it("drops saved replay state that read a deleted contract and keeps unrelated turns", async () => {
    const userId = "replay-owner";
    const deleted = await createContractForUser({ userId, title: "Deleted" });
    const kept = await createContractForUser({ userId, title: "Kept" });
    const readDeleted = readContractTurn(deleted.id.toUpperCase(), "call-1");
    const readKept = readContractTurn(kept.id, "call-2");
    const listedDeleted = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-3",
            toolName: "list_contracts",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-3",
            toolName: "list_contracts",
            output: {
              type: "json",
              value: { contracts: [{ id: deleted.id, title: "Deleted" }] },
            },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "One contract" }] },
    ];
    const deletedTurn = await saveTurn(userId, readDeleted);
    const keptTurn = await saveTurn(userId, readKept);
    const listedTurn = await saveTurn(userId, listedDeleted);
    const otherOwnerTurn = await saveTurn("replay-intruder", readDeleted);

    expect(
      await deleteContractForUser({ userId, contractId: deleted.id }),
    ).toEqual({ deleted: true });

    const scrubbed = await deletedTurn();
    expect(scrubbed?.content).toBe(STALE_CONTRACT_REPLY);
    expect((await getChatThreadByIdForUser(userId, scrubbed!.threadId))?.messages.at(-1)?.content).toBe("It quotes the secret clause.");
    expect(scrubbed?.agentMessages).toBeUndefined();
    const { rows } = await pool.current!.query(
      "SELECT metadata_json FROM chat_messages WHERE id = $1",
      [scrubbed!.id],
    );
    expect(rows[0].metadata_json).toMatchObject({
      contractEvidenceInvalid: true,
      toolActivity: [{ id: "call", query: "contract", status: "complete" }],
    });
    expect((await keptTurn())?.agentMessages).toEqual(readKept.slice(0, 2));
    expect((await listedTurn())?.agentMessages).toBeUndefined();
    expect((await otherOwnerTurn())?.agentMessages).toBeUndefined();
  });

  it("does not resurrect deleted evidence when an in-flight reply saves afterwards", async () => {
    const userId = "late-reply-owner";
    const item = await createContractForUser({ userId, title: "Contract" });
    const snapshot = await getContractWithLatestAnalysisForUser(userId, item.id);
    const receipts = [{ id: item.id, revision: snapshot!.revision }];
    const turn = readContractTurn(item.id, "in-flight");
    await deleteContractForUser({ userId, contractId: item.id });
    const read = await saveTurn(userId, turn, receipts);
    const reply = (await read())!;
    expect(reply.content).toBe(STALE_CONTRACT_REPLY);
    expect(reply.agentMessages).toBeUndefined();
    const stored = await pool.current!.query("SELECT metadata_json FROM chat_messages WHERE id = $1", [reply.id]);
    expect(JSON.stringify(stored.rows[0].metadata_json)).not.toContain("Secret clause text");
  });

  it("invalidates saved evidence and dependent follow-ups after a reupload", async () => {
    const userId = "revision-chat-owner";
    const item = await createContractForUser({ userId, title: "Revision" });
    const snapshot = await getContractWithLatestAnalysisForUser(userId, item.id);
    const refs = [{ id: item.id, revision: snapshot!.revision }];
    const first = await saveTurn(userId, readContractTurn(item.id, "read"), refs);
    const followup = await saveTurn(userId, [], refs);
    expect((await first())?.agentMessages).toBeDefined();
    await pool.current!.query("UPDATE contracts SET text_content = 'New cancellation terms', updated_at = clock_timestamp() WHERE id = $1", [item.id]);
    expect((await first())?.content).toBe(STALE_CONTRACT_REPLY);
    expect((await followup())?.content).toBe(STALE_CONTRACT_REPLY);
    const late = await saveTurn(userId, readContractTurn(item.id, "late"), refs);
    expect((await late())?.agentMessages).toBeUndefined();
  });

  it("drops saved replay state for contracts removed with their project", async () => {
    const userId = "replay-project-owner";
    const project = await createProjectForUser({ userId, title: "Replay" });
    const child = await createContractForUser({
      userId,
      title: "Child",
      projectId: project.id,
    });
    const turn = await saveTurn(userId, readContractTurn(child.id, "call-1"));
    expect(
      await deleteProjectForUser({ userId, projectId: project.id }),
    ).toEqual({ deleted: true });
    expect((await turn())?.agentMessages).toBeUndefined();
  });

  it("keeps the contract, project and replay state when the chat scrub fails", async () => {
    const userId = "replay-failure-owner";
    const project = await createProjectForUser({ userId, title: "Kept" });
    const item = await createContractForUser({
      userId,
      title: "Kept",
      projectId: project.id,
    });
    const agentMessages = readContractTurn(item.id, "call-1");
    const turn = await saveTurn(userId, agentMessages);
    const messageId = (await turn())!.id;
    await pool.current!.query(
      "CREATE FUNCTION fail_replay_scrub() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'replay scrub failed'; END $$",
    );
    try {
      await pool.current!.query(
        `CREATE TRIGGER fail_replay_scrub BEFORE UPDATE ON chat_messages FOR EACH ROW
         WHEN (OLD.id = '${messageId}') EXECUTE FUNCTION fail_replay_scrub()`,
      );
      await expect(
        deleteContractForUser({ userId, contractId: item.id }),
      ).rejects.toThrow(/replay scrub failed/);
      await expect(
        deleteProjectForUser({ userId, projectId: project.id }),
      ).rejects.toThrow(/replay scrub failed/);
    } finally {
      await pool.current!.query(
        "DROP TRIGGER IF EXISTS fail_replay_scrub ON chat_messages",
      );
      await pool.current!.query("DROP FUNCTION IF EXISTS fail_replay_scrub()");
    }
    expect(
      await getContractWithLatestAnalysisForUser(userId, item.id),
    ).not.toBeNull();
    expect(await getProjectByIdForUser(userId, project.id)).not.toBeNull();
    expect((await turn())?.agentMessages).toEqual(agentMessages.slice(0, 2));
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

  it("pages project contracts with only their deterministic latest analysis", async () => {
    const userId = "project-analysis-owner";
    const project = await createProjectForUser({ userId, title: "History" });
    await pool.current!.query(
      `INSERT INTO contracts(user_id, project_id, title, created_at)
       SELECT $1, $2, 'Contract ' || n, '2026-01-01'::timestamptz + n * interval '1 second'
       FROM generate_series(1, 51) n`,
      [userId, project.id],
    );
    const { rows: newest } = await pool.current!.query<{ id: string }>(
      "SELECT id FROM contracts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
      [project.id],
    );
    const contractId = newest[0]!.id;
    await pool.current!.query(
      `INSERT INTO analyses(contract_id, risk_badge, result_json, created_at)
       SELECT $1, 'LOW', '{}', '2020-01-01'::timestamptz + n * interval '1 second'
       FROM generate_series(1, 200) n`,
      [contractId],
    );
    // Equal timestamps must select the same ID in detail, generation gates, and history order.
    const latestId = "f0000000-0000-4000-8000-000000000002";
    await pool.current!.query(
      `INSERT INTO analyses(id, contract_id, risk_badge, result_json, created_at)
       VALUES ('f0000000-0000-4000-8000-000000000001', $1, 'MEDIUM', '{}', '2026-01-01'),
              ($2, $1, 'HIGH', '{}', '2026-01-01')`,
      [contractId, latestId],
    );

    const first = await getProjectByIdForUser(userId, project.id);
    expect(first?.contracts).toHaveLength(50);
    expect(first?.contractsHasMore).toBe(true);
    expect(first?.contracts[0]).toMatchObject({
      id: contractId,
      analyses: [{ id: latestId, riskBadge: "HIGH" }],
    });
    expect(first?.contracts.slice(1).every((item) => item.analyses.length === 0)).toBe(true);
    expect((await getContractAnalysisGateForUser(userId, contractId))?.latestAnalysisId).toBe(latestId);
    expect((await getContractWithLatestAnalysisForUser(userId, contractId))?.latestAnalysis?.id).toBe(latestId);
    const last = await getProjectByIdForUser(userId, project.id, { contractsOffset: 50 });
    expect(last?.contracts).toHaveLength(1);
    expect(last?.contracts[0]).toMatchObject({ title: "Contract 1", analyses: [] });
    expect(last?.contractsHasMore).toBe(false);
    expect(await getProjectByIdForUser("intruder", project.id)).toBeNull();
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

  it.each(["contract", "chat"] as const)(
    "admits only one overlapping %s operation across UUID casing and permits retry after release",
    async (kind) => {
      const item = kind === "contract"
        ? await contract()
        : await createChatThreadForUser({ userId: "owner" });
      const leases = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          claimGenerationOperation(
            "owner",
            kind,
            index % 2 ? item.id.toUpperCase() : item.id,
            60,
          ),
        ),
      );
      expect(leases.filter(Boolean)).toHaveLength(1);
      await leases.find(Boolean)!();
      const retry = await claimGenerationOperation(
        "owner",
        kind,
        item.id.toUpperCase(),
        60,
      );
      expect(retry).not.toBeNull();
      await retry!();
    },
  );

  async function expireGenerationLease(contractId: string) {
    const { rowCount } = await pool.current!.query(
      "UPDATE generation_operations SET expires_at = now() - interval '1 second' WHERE entity_key = $1",
      [`contract:owner:${contractId}`],
    );
    expect(rowCount).toBe(1);
  }

  it("lets a new claim take over an expired generation lease", async () => {
    const item = await contract();
    const expired = await claimGenerationOperation("owner", "contract", item.id, 60);
    expect(expired).not.toBeNull();
    expect(
      await claimGenerationOperation("owner", "contract", item.id, 60),
    ).toBeNull();
    await expireGenerationLease(item.id);
    const takeover = await claimGenerationOperation("owner", "contract", item.id, 60);
    expect(takeover).not.toBeNull();
    await takeover!();
  });

  it("ignores a stale lease release after another UUID casing took over", async () => {
    const item = await contract();
    const stale = await claimGenerationOperation("owner", "contract", item.id, 60);
    expect(stale).not.toBeNull();
    await expireGenerationLease(item.id);
    const fresh = await claimGenerationOperation(
      "owner", "contract", item.id.toUpperCase(), 60,
    );
    expect(fresh).not.toBeNull();
    await stale!();
    expect(
      await claimGenerationOperation("owner", "contract", item.id, 60),
    ).toBeNull();
    await fresh!();
    const again = await claimGenerationOperation("owner", "contract", item.id, 60);
    expect(again).not.toBeNull();
    await again!();
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

  it("applies each pending migration once when two runners race, without holding the lock afterwards", async () => {
    const db = pool.current!;
    const lockQuery =
      "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = 736194821";
    await db.query("DROP SCHEMA IF EXISTS migration_race CASCADE");
    await db.query("CREATE SCHEMA migration_race");
    const gate = await db.connect();
    const runners = [await db.connect(), await db.connect()];
    let running: Promise<unknown> | undefined;
    try {
      for (const runner of runners)
        await runner.query("SET search_path TO migration_race");
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(736194821)");
      // Both runners queue behind the gate, so both read an empty applied set and every file
      // must be skipped by whichever runner reaches it second.
      running = Promise.all(runners.map((runner) => runMigrations(runner)));
      await vi.waitFor(
        async () =>
          expect(
            (await db.query(`${lockQuery} AND NOT granted`)).rows[0].count,
          ).toBe(2),
        { timeout: 5_000 },
      );
      await gate.query("COMMIT");
      await running;
      const [raced, expected] = await Promise.all([
        db.query(
          "SELECT filename FROM migration_race.schema_migrations ORDER BY filename",
        ),
        db.query("SELECT filename FROM public.schema_migrations ORDER BY filename"),
      ]);
      expect(raced.rows).toEqual(expected.rows);
      expect((await db.query(lockQuery)).rows[0].count).toBe(0);
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await running?.catch(() => {});
      gate.release();
      for (const runner of runners) runner.release(true);
      await db.query("DROP SCHEMA IF EXISTS migration_race CASCADE");
    }
  });
});
