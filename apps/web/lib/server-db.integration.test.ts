import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { STALE_CONTRACT_REPLY, type ContractEvidence } from "./contract-evidence";
import { runMigrations } from "../db/migrations.js";
import { chatImage } from "./fixtures/chat-image";

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
  getInferenceQuota,
  claimStorageDeletions,
  deferStorageDeletion,
  completeStorageDeletion,
  createUploadCleanupIntent,
  createDirectUploadIntent,
  findDirectUploadIntent,
  getContractWindowForUser,
  getContractSourceForUser,
  saveContractNotesForUser,
  getAnalysisForUser,
  upsertUserSettings,
  getUserSettingsByUserId,
  appendChatMessagesToThread,
  claimGenerationOperation,
  createAnalysisForContract,
  createChatThreadForUser,
  deleteChatThreadForUser,
  createContractForUser,
  createProjectForUser,
  deleteAccountForUser,
  getAccountExportForUser,
  deleteAnalysisForContract,
  deleteContractForUser,
  deleteProjectForUser,
  getChatImageForUser,
  saveChatFileForUser,
  getChatFileForUser,
  getChatDocumentsForUser,
  getChatThreadByIdForUser,
  getChatTurnByTurnId,
  getContractAnalysisGateForUser,
  getContractByIdForUser,
  getContractTextForUser,
  getContractWithLatestAnalysisForUser,
  getProjectByIdForUser,
  getProjectContextForAnalysis,
  listProjectContextDocumentsForUser,
  getRecentChatMessagesForThreadForUser,
  listChatThreadsByUserId,
  listContractsByUserId,
  listContractsForChat,
  listProjectsByUserId,
  saveContractUploadForUser,
  setContractJurisdictionForUser,
  addContextDocumentToProject,
} from "./server-db";
import { resolveWorkOSUserId } from "./auth-identity";
import { attachAnalysisSources, contractSourceRevision } from "./analysis-sources";
import {
  citationForReport,
  CONTRACT_ANALYSIS_LIMIT,
  contractAnalysisSegments,
  MAX_ANALYSED_SECTIONS,
} from "./source-citations";
import { buildAnalysisPrompt } from "./analysis";
import { CONTRACT_SEARCH_EXCERPT_LENGTH, MAX_CONTRACT_SEARCH_LENGTH } from "./contract-search";
import { boundCanonicalChatHistory } from "./chat-history-bounds";
import { admissionLimits, type AdmissionResult } from "./inference-policy";
import { createAccountExport } from "./account-export";
import { json, unzip } from "./test-unzip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// db/test-integration.sh sets this and runs vitest directly, outside turbo's env filtering.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.REQUIRE_DB_TESTS === "1" && !connectionString)
  throw new Error(
    "REQUIRE_DB_TESTS=1 but SIGNLOOP_TEST_DATABASE_URL is unset; refusing to skip the database suite",
  );

const TEST_OWNERS = [
  "another-user", "bounded-followup-owner", "chat-owner", "chat-pagination-owner",
  "chat-search-intruder", "chat-search-owner", "chat-search-paging-owner",
  "content-receipt-owner", "empty-lookup-intruder", "empty-lookup-owner", "file-owner",
  "filter-intruder", "filter-owner", "filter-paging-owner",
  "interrupted-turn-owner", "intruder", "late-reply-owner", "legacy-receipt-owner", "other", "owner", "OWNER",
  "project-analysis-owner", "project-search-intruder", "project-search-owner",
  "project-search-paging-owner", "quota-owner", "replay-failure-owner", "replay-intruder",
  "replay-owner", "replay-project-owner", "revision-chat-owner", "scope-user", "search-intruder",
  "search-owner", "search-paging-owner", "settings-owner", "text-search-intruder",
  "text-search-owner", "text-search-paging-owner", "title-owner", "turn-intruder", "turn-owner",
];

describe.skipIf(!connectionString)("database integration", () => {
  it("persists visual inputs privately, restores them for follow-ups, and deletes their bytes with the chat", async () => {
    const thread = await createChatThreadForUser({ userId: "file-owner" });
    const image = { ...chatImage, id: crypto.randomUUID() };
    const data = Buffer.from(image.data, "base64");
    const saved = await saveChatFileForUser({ userId: "file-owner", threadId: thread.id, file: image, data });
    expect(saved).not.toHaveProperty("data");
    expect(await getChatDocumentsForUser("file-owner", thread.id, [image.id])).toEqual([image]);
    expect(await getChatDocumentsForUser("other", thread.id, [image.id])).toEqual([]);
    expect(await getChatFileForUser("other", thread.id, image.id)).toBeNull();
    await appendChatMessagesToThread({ userId: "file-owner", threadId: thread.id, messages: [
      { role: "user", content: "Describe", metadata: { files: [saved] } },
      { role: "assistant", content: "An image" },
    ] });
    expect((await getChatThreadByIdForUser("file-owner", thread.id))?.messages[0]?.files).toEqual([saved]);
    expect((await getRecentChatMessagesForThreadForUser("file-owner", thread.id, 10))?.[0]?.files).toEqual([saved]);
    expect((await getChatFileForUser("file-owner", thread.id, image.id))?.data).toEqual(data);
    const exported = await getAccountExportForUser("file-owner");
    expect(exported.chatFiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: image.id, mediaType: "image/png" })]));
    await deleteChatThreadForUser({ userId: "file-owner", threadId: thread.id });
    expect(await getChatFileForUser("file-owner", thread.id, image.id)).toBeNull();
  });

  it("keeps chat uploads/downloads owner-scoped, transactional, and deleted with their thread", async () => {
    const thread = await createChatThreadForUser({ userId: "file-owner" });
    const document = { id: crypto.randomUUID(), name: "terms.txt", mediaType: "text/plain", size: 12, text: "Private text" };
    const saved = await saveChatFileForUser({ userId: "file-owner", threadId: thread.id, file: document, data: Buffer.from(document.text) });
    expect(saved?.url).toContain(document.id);
    expect(await saveChatFileForUser({ userId: "other", threadId: thread.id, file: { ...document, id: crypto.randomUUID() }, data: Buffer.from(document.text) })).toBeNull();
    expect(await getChatFileForUser("other", thread.id, document.id)).toBeNull();
    expect(await getChatDocumentsForUser("other", thread.id, [document.id])).toEqual([]);
    expect(await getChatDocumentsForUser("file-owner", thread.id, [document.id])).toEqual([document]);
    const generated = { ...document, id: crypto.randomUUID(), name: "summary.txt", text: "Summary", data: Buffer.from("Summary").toString("base64"), size: 7 };
    const download = { id: generated.id, name: generated.name, mediaType: generated.mediaType, size: generated.size, url: `/api/chat/threads/${thread.id}/files/${generated.id}` };
    await appendChatMessagesToThread({ userId: "file-owner", threadId: thread.id, generatedFiles: [generated], messages: [
      { role: "user", content: "Summarize", metadata: { files: [saved] } },
      { role: "assistant", content: "Here is your file.", metadata: { files: [download] } },
    ] });
    expect((await getChatFileForUser("file-owner", thread.id, generated.id))?.data.toString()).toBe("Summary");
    const visible = await getChatThreadByIdForUser("file-owner", thread.id);
    expect(visible?.messages[0]?.files).toEqual([saved]);
    expect(visible?.messages[1]?.files).toEqual([download]);
    expect(JSON.stringify(visible)).not.toContain(generated.data);
    // A download derived from stale contract evidence stays visible, but must not restore that
    // evidence to model context through read_file after the receipt has been invalidated.
    await appendChatMessagesToThread({ userId: "file-owner", threadId: thread.id, messages: [
      { role: "assistant", content: "Historical contract export", metadata: { files: [download], contractEvidenceInvalid: true } },
    ] });
    expect((await getChatThreadByIdForUser("file-owner", thread.id))?.messages.at(-1)?.files).toEqual([download]);
    expect((await getRecentChatMessagesForThreadForUser("file-owner", thread.id, 10))?.at(-1)?.files).toBeUndefined();
    const failed = { ...generated, id: crypto.randomUUID() };
    await expect(appendChatMessagesToThread({ userId: "file-owner", threadId: thread.id, generatedFiles: [failed], messages: [
      { role: "assistant", content: "Uncommitted", metadata: { cannotSerialize: 1n } },
    ] })).rejects.toThrow();
    expect(await getChatFileForUser("file-owner", thread.id, failed.id)).toBeNull();
    await deleteChatThreadForUser({ userId: "file-owner", threadId: thread.id });
    expect(await getChatFileForUser("file-owner", thread.id, document.id)).toBeNull();
    expect((await pool.current!.query("SELECT id FROM chat_files WHERE thread_id = $1", [thread.id])).rowCount).toBe(0);
  });

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
      // Owner-rooted inserts require the owner's application_users row, as every signed-in
      // owner has (see deleteAccountForUser).
      await client.query(
        "INSERT INTO application_users(id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
        [TEST_OWNERS],
      );
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

  it("removes only an owned, empty, idle thread during abandoned-draft cleanup", async () => {
    const thread = await createChatThreadForUser({ userId: "owner" });
    const discard = (userId: string) => deleteChatThreadForUser({
      userId, threadId: thread.id, onlyIfEmpty: true,
    });
    expect(await discard("another-owner")).toBe(false);
    const release = await claimGenerationOperation("owner", "chat", thread.id, 60);
    expect(release).toBeTypeOf("function");
    try {
      expect(await deleteChatThreadForUser({
        userId: "owner", threadId: thread.id.toUpperCase(), onlyIfEmpty: true,
      })).toBe(false);
      expect(await getChatThreadByIdForUser("owner", thread.id)).not.toBeNull();
    } finally {
      await release?.();
    }
    expect(await discard("owner")).toBe(true);
    expect(await getChatThreadByIdForUser("owner", thread.id)).toBeNull();
    expect(await discard("owner")).toBe(false);
  });

  it("preserves messages committed while empty-thread cleanup waits for the row lock", async () => {
    const thread = await createChatThreadForUser({ userId: "owner" });
    const writer = await pool.current!.connect();
    let cleanup: Promise<boolean> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM chat_threads WHERE id = $1 FOR UPDATE", [thread.id]);
      await writer.query(
        "INSERT INTO chat_messages (thread_id, role, content, position) VALUES ($1, 'user', 'Keep this message', 1)",
        [thread.id],
      );
      cleanup = deleteChatThreadForUser({ userId: "owner", threadId: thread.id, onlyIfEmpty: true });
      await vi.waitFor(async () => {
        const lease = await pool.current!.query(
          "SELECT 1 FROM generation_operations WHERE entity_key = $1",
          [`chat:owner:${thread.id}`],
        );
        expect(lease.rowCount).toBe(1);
      });
      await writer.query("COMMIT");
      expect(await cleanup).toBe(false);
      const saved = await getChatThreadByIdForUser("owner", thread.id);
      expect(saved?.messages.map((message) => message.content)).toEqual(["Keep this message"]);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await cleanup;
    }
    const release = await claimGenerationOperation("owner", "chat", thread.id, 60);
    expect(release).toBeTypeOf("function");
    await release?.();
  });
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

  it("returns analysis coverage counts in contract detail without the text, in code points", async () => {
    const item = await contract();
    const textless = await getContractByIdForUser("owner", item.id);
    expect(textless?.analysisCoverage).toEqual({
      characterCount: 0,
      sectionCount: 1,
      analysedSectionCount: 1,
      uncoveredFrom: null,
    });

    // At the limit in code points (twice that in UTF-16 units) is still one section.
    const oneSection = "😀".repeat(CONTRACT_ANALYSIS_LIMIT);
    await pool.current!.query("UPDATE contracts SET text_content = $1 WHERE id = $2", [oneSection, item.id]);
    expect((await getContractByIdForUser("owner", item.id))?.analysisCoverage).toEqual({
      characterCount: CONTRACT_ANALYSIS_LIMIT,
      sectionCount: 1,
      analysedSectionCount: 1,
      uncoveredFrom: null,
    });

    const clause = (n: number) => `${n}. Clause ${n} ${"😀".repeat(4_000)} terms.\n\n`;
    const long = Array.from({ length: 80 }, (_, i) => clause(i + 1)).join("");
    await pool.current!.query("UPDATE contracts SET text_content = $1 WHERE id = $2", [long, item.id]);
    const detail = await getContractByIdForUser("owner", item.id);
    const segments = contractAnalysisSegments(long);
    expect(segments.length).toBeGreaterThan(MAX_ANALYSED_SECTIONS);
    expect(detail?.analysisCoverage).toEqual({
      characterCount: Array.from(long).length,
      sectionCount: segments.length,
      analysedSectionCount: MAX_ANALYSED_SECTIONS,
      uncoveredFrom: segments[MAX_ANALYSED_SECTIONS]!.start,
    });
    const body = JSON.stringify(detail);
    expect(body).not.toContain("Clause");
    expect(body).not.toContain("😀");
    for (const key of ["text", "textContent", "sectionedText", "characterCount"]) {
      expect(detail).not.toHaveProperty(key);
    }
    expect(await getContractByIdForUser("intruder", item.id)).toBeNull();
  });

  it("confirms, changes, and clears a contract's jurisdiction for its owner only", async () => {
    const item = await contract();
    expect(await getContractByIdForUser("owner", item.id)).toMatchObject({
      confirmedJurisdiction: null,
      jurisdictionConfirmedAt: null,
    });
    const before = await getContractWithLatestAnalysisForUser("owner", item.id);
    expect(before?.confirmedJurisdiction).toBeNull();

    expect(
      await setContractJurisdictionForUser({ userId: "intruder", contractId: item.id, jurisdiction: "Quebec" }),
    ).toBeNull();
    const confirmed = await setContractJurisdictionForUser({ userId: "owner", contractId: item.id, jurisdiction: "Ontario" });
    expect(confirmed).toMatchObject({ confirmedJurisdiction: "Ontario" });
    expect(confirmed?.jurisdictionConfirmedAt).toBeTruthy();
    expect(await getContractByIdForUser("owner", item.id)).toMatchObject({ confirmedJurisdiction: "Ontario" });
    expect(await getContractByIdForUser("intruder", item.id)).toBeNull();
    // The next analysis reads it, and confirming does not move the analysis revision.
    const after = await getContractWithLatestAnalysisForUser("owner", item.id);
    expect(after).toMatchObject({ confirmedJurisdiction: "Ontario", revision: before!.revision });

    expect(
      await setContractJurisdictionForUser({ userId: "owner", contractId: item.id, jurisdiction: "England and Wales" }),
    ).toMatchObject({ confirmedJurisdiction: "England and Wales" });
    expect(
      await setContractJurisdictionForUser({ userId: "owner", contractId: item.id, jurisdiction: null }),
    ).toEqual({ confirmedJurisdiction: null, jurisdictionConfirmedAt: null });

    // Migration 019 bounds the value and keeps it paired with its confirmation time.
    await expect(
      pool.current!.query("UPDATE contracts SET confirmed_jurisdiction = $2, jurisdiction_confirmed_at = now() WHERE id = $1", [item.id, "x".repeat(101)]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pool.current!.query("UPDATE contracts SET confirmed_jurisdiction = 'Ontario' WHERE id = $1", [item.id]),
    ).rejects.toThrow(/contracts_jurisdiction_confirmation_check/);
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

  it("rechecks report existence, highlights quotes from a section of a long contract, and rejects mismatched spans", async () => {
    const item = await contract();
    const renewal =
      "9.2 Renewal. This Agreement renews automatically unless notice is given 60 days before renewal.\n";
    const text = "x".repeat(10000) + "\n" + renewal + "x".repeat(10000) + "END";
    await pool.current!.query(
      "UPDATE contracts SET text_content = $1 WHERE id = $2",
      [text, item.id],
    );
    const snapshot = await getContractWithLatestAnalysisForUser("owner", item.id);
    const saved = await createAnalysisForContract({
      userId: "owner",
      contractId: item.id,
      expectedRevision: snapshot!.revision,
      riskBadge: "LOW",
      resultJson: attachAnalysisSources(
        {
          red_flags: [
            { evidence: { quote: "renews automatically", segment: "section-2" } },
          ],
        },
        item.id,
        text,
      ),
      llmProvider: "test",
      llmModel: "test",
    });
    const revision = contractSourceRevision(text);
    const base = {
      userId: "owner",
      contractId: item.id,
      analysisId: saved.id,
      offset: 0,
      revision,
    };
    const stored = await getAnalysisForUser("owner", item.id, saved.id);
    const citation = citationForReport(stored?.resultJson, item.id, 0)!;
    expect(citation).toMatchObject({
      quote: "renews automatically",
      start: text.indexOf("renews automatically"),
    });
    expect(
      (await getContractSourceForUser({ ...base, citation }))?.highlightMatches,
    ).toBe(true);
    expect(
      (
        await getContractSourceForUser({
          ...base,
          citation: { ...citation, quote: "renews annually....." },
        })
      )?.highlightMatches,
    ).toBe(false);
    expect(
      (
        await getContractSourceForUser({
          ...base,
          citation: { ...citation, start: 0, end: citation.end - citation.start },
        })
      )?.highlightMatches,
    ).toBe(false);
    expect(
      (
        await getContractSourceForUser({
          ...base,
          citation: {
            ...citation,
            quote: "END",
            start: text.length - 3,
            end: text.length,
          },
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

  it("stores a retried chat turn once and finds it only in its owner's thread", async () => {
    const userId = "turn-owner";
    const thread = await createChatThreadForUser({ userId });
    await appendChatMessagesToThread({ userId, threadId: thread.id, messages: [
      { role: "user", content: "An earlier question" },
      { role: "assistant", content: "An earlier answer" },
    ] });
    const turnId = crypto.randomUUID();
    const download = (id: string, text: string) => ({
      id, name: "summary.txt", mediaType: "text/plain", size: text.length, text,
      data: Buffer.from(text).toString("base64"),
    });
    const turn = (answer: string, file: ReturnType<typeof download>) =>
      appendChatMessagesToThread({ userId, threadId: thread.id, turnId, generatedFiles: [file], messages: [
        { role: "user", content: "Summarize the fees" },
        { role: "assistant", content: answer, metadata: { files: [{ id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, url: `/api/chat/threads/${thread.id}/files/${file.id}` }] } },
      ] });

    const first = await turn("Fees are 2%.", download(crypto.randomUUID(), "First"));
    expect(first.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(await getChatTurnByTurnId(userId, thread.id, turnId)).toEqual(first);

    // A retry that raced past the route's check returns the saved pair and writes nothing,
    // including its own generated download.
    const retriedFile = download(crypto.randomUUID(), "Second");
    expect(await turn("Fees are 3%.", retriedFile)).toEqual(first);
    expect((await getChatThreadByIdForUser(userId, thread.id))?.messages.map((message) => message.content))
      .toEqual(["An earlier question", "An earlier answer", "Summarize the fees", "Fees are 2%."]);
    expect(await getChatFileForUser(userId, thread.id, retriedFile.id)).toBeNull();

    // Two attempts at once serialize on the thread lock and still store one pair.
    const racedTurnId = crypto.randomUUID();
    const raced = await Promise.all([1, 2].map((attempt) =>
      appendChatMessagesToThread({ userId, threadId: thread.id, turnId: racedTurnId, messages: [
        { role: "user", content: "Any penalties?" },
        { role: "assistant", content: `Attempt ${attempt}` },
      ] }),
    ));
    expect(raced[0]).toEqual(raced[1]);
    expect((await getChatThreadByIdForUser(userId, thread.id))?.messages).toHaveLength(6);

    // Lookups are scoped by owner and thread, and need the saved reply, not just the question.
    const intruderThread = await createChatThreadForUser({ userId: "turn-intruder" });
    await appendChatMessagesToThread({ userId: "turn-intruder", threadId: intruderThread.id, turnId, messages: [
      { role: "user", content: "Same id, other owner" },
      { role: "assistant", content: "Their own answer" },
    ] });
    expect(await getChatTurnByTurnId("turn-intruder", thread.id, turnId)).toBeNull();
    expect(await getChatTurnByTurnId(userId, intruderThread.id, turnId)).toBeNull();
    expect((await getChatTurnByTurnId("turn-intruder", intruderThread.id, turnId))?.[1]?.content)
      .toBe("Their own answer");
    const unanswered = crypto.randomUUID();
    await appendChatMessagesToThread({ userId, threadId: thread.id, turnId: unanswered, messages: [
      { role: "user", content: "A question with no saved reply" },
    ] });
    expect(await getChatTurnByTurnId(userId, thread.id, unanswered)).toBeNull();
    expect(await getChatTurnByTurnId(userId, thread.id, crypto.randomUUID())).toBeNull();

    // The id lives in existing metadata, so export still reads every message.
    const exported = await getAccountExportForUser(userId);
    expect(exported.chatMessages.filter((message) => message.threadId === thread.id)).toHaveLength(7);
  });

  it("keeps an interrupted turn readable, retries it into one finished turn, and exports and deletes it", async () => {
    const userId = "interrupted-turn-owner";
    const thread = await createChatThreadForUser({ userId });
    await appendChatMessagesToThread({ userId, threadId: thread.id, messages: [
      { role: "user", content: "An earlier question" },
      { role: "assistant", content: "An earlier answer" },
    ] });
    const turnId = crypto.randomUUID();
    const interrupted = { interrupted: true, interruptedReason: "stopped" };
    // The partial reply carries a generated image, which is stored as an attachment.
    await appendChatMessagesToThread({ userId, threadId: thread.id, turnId, messages: [
      { role: "user", content: "Summarize the fees" },
      {
        role: "assistant",
        content: `Fees are ![Generated image](data:image/png;base64,${chatImage.data})`,
        metadata: interrupted,
      },
    ] });
    const attachments = async () =>
      Number((await pool.current!.query(
        "SELECT count(*) AS n FROM chat_attachments WHERE thread_id = $1", [thread.id],
      )).rows[0].n);
    expect(await attachments()).toBe(1);

    // Reloading shows the question and partial answer, marked; it is not a saved answer to replay.
    expect(await getChatTurnByTurnId(userId, thread.id, turnId)).toBeNull();
    const shown = (await getChatThreadByIdForUser(userId, thread.id))!.messages;
    expect(shown.map(({ role, turnId: id, interrupted: reason }) => ({ role, id, reason }))).toEqual([
      { role: "user", id: undefined, reason: undefined },
      { role: "assistant", id: undefined, reason: undefined },
      { role: "user", id: turnId, reason: undefined },
      { role: "assistant", id: undefined, reason: "stopped" },
    ]);
    const history = (await getRecentChatMessagesForThreadForUser(userId, thread.id, 10))!;
    expect(history.at(-2)?.turnId).toBe(turnId);
    expect(history.at(-1)?.interrupted).toBe("stopped");

    // Account export includes the interrupted turn through the existing path.
    const exported = (await getAccountExportForUser(userId)).chatMessages
      .filter((message) => message.threadId === thread.id);
    expect(exported).toHaveLength(4);
    expect(exported[3]).toMatchObject({ role: "assistant", interrupted: "stopped" });

    // Two retries racing on the thread lock leave exactly one question and one finished answer.
    const raced = await Promise.all([1, 2].map((attempt) =>
      appendChatMessagesToThread({ userId, threadId: thread.id, turnId, messages: [
        { role: "user", content: "Summarize the fees" },
        { role: "assistant", content: `Fees are 2% (attempt ${attempt}).` },
      ] }),
    ));
    expect(raced[0]).toEqual(raced[1]);
    const retried = (await getChatThreadByIdForUser(userId, thread.id))!.messages;
    expect(retried.map((message) => message.content)).toEqual([
      "An earlier question", "An earlier answer", "Summarize the fees", raced[0]![1]!.content,
    ]);
    expect(retried.some((message) => message.interrupted)).toBe(false);
    expect(await attachments()).toBe(0);
    expect(await getChatTurnByTurnId(userId, thread.id, turnId)).toEqual(raced[0]);

    // A late interrupted save of a turn that has since finished writes nothing.
    expect(await appendChatMessagesToThread({ userId, threadId: thread.id, turnId, messages: [
      { role: "user", content: "Summarize the fees" },
      { role: "assistant", content: "Fees", metadata: interrupted },
    ] })).toEqual(raced[0]);

    // A turn cut off before any reply text keeps the question alone, marked, until it is retried.
    const unanswered = crypto.randomUUID();
    await appendChatMessagesToThread({ userId, threadId: thread.id, turnId: unanswered, messages: [
      { role: "user", content: "Any penalties?", metadata: { ...interrupted, interruptedReason: "error" } },
    ] });
    expect(await getChatTurnByTurnId(userId, thread.id, unanswered)).toBeNull();
    expect((await getChatThreadByIdForUser(userId, thread.id))!.messages.at(-1))
      .toMatchObject({ content: "Any penalties?", turnId: unanswered, interrupted: "error" });
    await appendChatMessagesToThread({ userId, threadId: thread.id, turnId: unanswered, messages: [
      { role: "user", content: "Any penalties?" },
      { role: "assistant", content: "No penalties apply." },
    ] });
    const final = (await getChatThreadByIdForUser(userId, thread.id))!.messages;
    expect(final.map((message) => message.content).slice(-2)).toEqual(["Any penalties?", "No penalties apply."]);
    expect(final).toHaveLength(6);
    expect(final.some((message) => message.interrupted)).toBe(false);

    // A save its caller abandoned rolls back, whether it is stopped before it starts or just
    // before it would commit.
    const abandoned = crypto.randomUUID();
    const save = (signal: AbortSignal) =>
      appendChatMessagesToThread({ userId, threadId: thread.id, turnId: abandoned, signal, messages: [
        { role: "user", content: "Abandoned question", metadata: interrupted },
      ] });
    await expect(save(AbortSignal.abort(new Error("gave up")))).rejects.toThrow("gave up");
    let checks = 0;
    const abortsBeforeCommit = {
      throwIfAborted() {
        if (++checks === 2) throw new Error("gave up before commit");
      },
    } as AbortSignal;
    await expect(save(abortsBeforeCommit)).rejects.toThrow("gave up before commit");
    expect(checks).toBe(2);
    expect((await getChatThreadByIdForUser(userId, thread.id))!.messages).toHaveLength(6);

    // Account deletion removes interrupted turns along with every other message.
    await appendChatMessagesToThread({ userId, threadId: thread.id, turnId: crypto.randomUUID(), messages: [
      { role: "user", content: "One more", metadata: interrupted },
    ] });
    await deleteAccountForUser(userId, { keepLogin: true });
    expect(Number((await pool.current!.query(
      "SELECT count(*) AS n FROM chat_messages WHERE thread_id = $1", [thread.id],
    )).rows[0].n)).toBe(0);
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
    const chatChecks = await pool.current!.query(
      "SELECT convalidated FROM pg_constraint WHERE conrelid = 'chat_files'::regclass AND conname IN ('chat_files_media_type_check', 'chat_files_content_check')",
    );
    expect(chatChecks.rows).toHaveLength(2);
    expect(chatChecks.rows.every((row) => row.convalidated)).toBe(true);
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
      `SELECT id, 'sha256:' || encode(digest(convert_to(coalesce(text_content, ''), 'UTF8'), 'sha256'), 'hex') AS revision FROM contracts WHERE id = ANY($1::uuid[])`, [ids],
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
    const snapshot = await getContractTextForUser(userId, item.id);
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
    const snapshot = await getContractTextForUser(userId, item.id);
    const refs = [{ id: item.id, revision: snapshot!.revision }];
    const first = await saveTurn(userId, readContractTurn(item.id, "read"), refs);
    const followup = await saveTurn(userId, [], refs);
    expect((await first())?.agentMessages).toBeDefined();
    await pool.current!.query("UPDATE contracts SET text_content = 'New cancellation terms', updated_at = clock_timestamp() WHERE id = $1", [item.id]);
    expect((await first())?.content).toBe(STALE_CONTRACT_REPLY);
    expect((await followup())?.content).toBe(STALE_CONTRACT_REPLY);
    const late = await saveTurn(userId, readContractTurn(item.id, "late"), refs);
    expect((await late())?.agentMessages).toBeUndefined();
    // A reply that saw both texts cannot replay either, even though one is current.
    const current = await getContractTextForUser(userId, item.id);
    expect(current?.revision).toBe(contractSourceRevision("New cancellation terms"));
    const mixed = await saveTurn(userId, readContractTurn(item.id, "mixed"), [
      ...refs, { id: item.id, revision: current!.revision },
    ]);
    expect((await mixed())?.content).toBe(STALE_CONTRACT_REPLY);
    const fresh = await saveTurn(userId, readContractTurn(item.id, "fresh"), [
      { id: item.id, revision: current!.revision },
    ]);
    expect((await fresh())?.agentMessages).toBeDefined();
  });

  it("keeps unchanged contract chat evidence through analysis and project context changes", async () => {
    const userId = "content-receipt-owner";
    const project = await createProjectForUser({ userId, title: "Receipts" });
    const item = await createContractForUser({ userId, title: "Fees", projectId: project.id });
    await pool.current!.query("UPDATE contracts SET text_content = 'The fee is $500.' WHERE id = $1", [item.id]);
    // Receipts come from the chat tools; analysis concurrency uses its own revision.
    const [listed] = (await listContractsForChat(userId)).contracts;
    const read = await getContractTextForUser(userId, item.id);
    const window = await getContractWindowForUser(userId, item.id, 0);
    expect(new Set([listed?.revision, read?.revision, window?.revision])).toEqual(
      new Set([contractSourceRevision("The fee is $500.")]),
    );
    const refs = [{ id: item.id, revision: read!.revision }];
    const first = await saveTurn(userId, readContractTurn(item.id, "read"), refs);
    const followup = await saveTurn(userId, [], refs);
    const live = async () => {
      expect((await first())?.agentMessages).toEqual(readContractTurn(item.id, "read").slice(0, 2));
      expect((await followup())?.content).toBe("It quotes the secret clause.");
    };

    const before = await getContractWithLatestAnalysisForUser(userId, item.id);
    // An in-flight reply that started before the analysis still saves its replay state.
    const saved = await createAnalysisForContract({
      userId,
      contractId: item.id,
      expectedRevision: before!.revision,
      riskBadge: "LOW",
      resultJson: result,
      llmProvider: "test",
      llmModel: "test",
    });
    const inFlight = await saveTurn(userId, readContractTurn(item.id, "in-flight"), refs);
    await live();
    expect((await inFlight())?.agentMessages).toBeDefined();

    const analysed = await getContractWithLatestAnalysisForUser(userId, item.id);
    expect(analysed?.revision).not.toBe(before?.revision);
    await expect(
      createAnalysisForContract({
        userId,
        contractId: item.id,
        expectedRevision: before!.revision,
        riskBadge: "LOW",
        resultJson: result,
        llmProvider: "test",
        llmModel: "test",
      }),
    ).rejects.toThrow(/changed/i);

    await deleteAnalysisForContract({ userId, contractId: item.id, analysisId: saved.id });
    expect((await getContractWithLatestAnalysisForUser(userId, item.id))?.revision).not.toBe(
      analysed?.revision,
    );
    await live();

    const contextBefore = await getContractWithLatestAnalysisForUser(userId, item.id);
    await pool.current!.query(
      "INSERT INTO context_documents(project_id, title, extracted_text) VALUES ($1, 'Context', 'New evidence')",
      [project.id],
    );
    await pool.current!.query("DELETE FROM context_documents WHERE project_id = $1", [project.id]);
    expect((await getContractWithLatestAnalysisForUser(userId, item.id))?.revision).not.toBe(
      contextBefore?.revision,
    );
    await live();
    expect((await getContractTextForUser(userId, item.id))?.revision).toBe(read!.revision);

    await deleteContractForUser({ userId, contractId: item.id });
    expect((await first())?.content).toBe(STALE_CONTRACT_REPLY);
    expect((await followup())?.content).toBe(STALE_CONTRACT_REPLY);
  });

  it("verifies pre-hash timestamp receipts only while the contract is unchanged", async () => {
    const userId = "legacy-receipt-owner";
    const item = await createContractForUser({ userId, title: "Legacy" });
    await pool.current!.query("UPDATE contracts SET text_content = 'Legacy fee clause.' WHERE id = $1", [item.id]);
    const stamp = [{ id: item.id, revision: (await getContractWithLatestAnalysisForUser(userId, item.id))!.revision }];
    const content = [{ id: item.id, revision: contractSourceRevision("Legacy fee clause.") }];
    const storedReceipts = async (id: string) => (await pool.current!.query(
      "SELECT metadata_json->'contractEvidence' AS receipts FROM chat_messages WHERE id = $1", [id],
    )).rows[0].receipts;
    // A row saved before content hashes.
    const legacy = await saveTurn(userId, readContractTurn(item.id, "legacy"), content);
    await pool.current!.query(
      "UPDATE chat_messages SET metadata_json = jsonb_set(metadata_json, '{contractEvidence}', $2::jsonb) WHERE id = $1",
      [(await legacy())!.id, JSON.stringify(stamp)],
    );
    // A matching timestamp vouches for the text read from the same row version.
    expect((await legacy())?.contractEvidence).toEqual(content);
    expect((await legacy())?.agentMessages).toBeDefined();
    expect(await storedReceipts((await legacy())!.id)).toEqual(stamp);
    // An inherited timestamp is verified under the row lock and stored as the hash.
    const followup = await saveTurn(userId, [], stamp);
    expect(await storedReceipts((await followup())!.id)).toEqual(content);

    // The timestamp cannot tell an analysis from a re-upload, so the legacy turn fails closed.
    await createAnalysisForContract({
      userId,
      contractId: item.id,
      expectedRevision: stamp[0]!.revision,
      riskBadge: "LOW",
      resultJson: result,
      llmProvider: "test",
      llmModel: "test",
    });
    expect((await legacy())?.content).toBe(STALE_CONTRACT_REPLY);
    expect((await followup())?.content).toBe("It quotes the secret clause.");
    const late = await saveTurn(userId, readContractTurn(item.id, "late"), stamp);
    expect((await late())?.agentMessages).toBeUndefined();
  });

  it("carries saved receipts through canonical bounding so a tool-free followup is invalidated", async () => {
    const userId = "bounded-followup-owner";
    const item = await createContractForUser({ userId, title: "Fee agreement" });
    const snapshot = await getContractTextForUser(userId, item.id);
    const thread = await createChatThreadForUser({ userId, title: "Fees" });
    await appendChatMessagesToThread({
      userId,
      threadId: thread.id,
      messages: [
        { role: "user", content: "Read my fee agreement" },
        {
          role: "assistant",
          content: "The fee is $500.",
          metadata: { contractEvidence: [{ id: item.id, revision: snapshot!.revision }] },
        },
      ],
    });
    // The saved-chat route rebuilds model history from these rows through the canonical bounds.
    const recent = await getRecentChatMessagesForThreadForUser(userId, thread.id, 29);
    const inherited = boundCanonicalChatHistory(recent!).flatMap(
      (message) => message.contractEvidence ?? [],
    );
    expect(inherited).toEqual([{ id: item.id, revision: snapshot!.revision }]);
    await appendChatMessagesToThread({
      userId,
      threadId: thread.id,
      messages: [
        { role: "user", content: "Explain that fee" },
        {
          role: "assistant",
          content: "This means you pay $500 on cancellation.",
          metadata: { contractEvidence: inherited, agentMessages: [], toolActivity: [] },
        },
      ],
    });
    expect((await getRecentChatMessagesForThreadForUser(userId, thread.id, 29))?.at(-1)?.content).toBe(
      "This means you pay $500 on cancellation.",
    );

    await deleteContractForUser({ userId, contractId: item.id });
    const after = await getRecentChatMessagesForThreadForUser(userId, thread.id, 29);
    expect(after?.map((message) => message.content)).toEqual([
      "Read my fee agreement",
      STALE_CONTRACT_REPLY,
      "Explain that fee",
      STALE_CONTRACT_REPLY,
    ]);
    expect(boundCanonicalChatHistory(after!).flatMap((message) => message.contractEvidence ?? [])).toEqual([]);
  });

  it("keeps empty contract lookups replayable while receipt-less tool turns fail closed", async () => {
    const userId = "empty-lookup-owner";
    const foreign = await createContractForUser({ userId: "empty-lookup-intruder", title: "Not yours" });
    // What the chat tools see for this owner: an empty listing and a missing contract.
    expect(await listContractsForChat(userId, {})).toEqual({ contracts: [], nextOffset: null });
    expect(await getContractWindowForUser(userId, foreign.id, 0)).toBeNull();
    const lookups = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "list", toolName: "list_contracts", input: {} },
          { type: "tool-call", toolCallId: "read", toolName: "read_contract", input: { contractId: foreign.id } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "list",
            toolName: "list_contracts",
            output: { type: "json", value: { nextOffset: null, hasMore: false, contracts: [] } },
          },
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read_contract",
            output: { type: "json", value: { error: "Contract not found. Call list_contracts to see available ids." } },
          },
        ],
      },
    ];
    const toolActivity = [
      { id: "list", tool: "list_contracts", query: "", status: "complete" },
      { id: "read", tool: "read_contract", query: foreign.id, status: "error" },
    ];
    const answer = "You have no uploaded contracts yet.";
    const lookupTurn = async (contractEvidence?: unknown) => {
      const thread = await createChatThreadForUser({ userId, title: "Lookup" });
      await appendChatMessagesToThread({
        userId,
        threadId: thread.id,
        messages: [
          { role: "user", content: "Which contracts do I have?" },
          {
            role: "assistant",
            content: answer,
            metadata: { agentMessages: lookups, contractEvidence, toolActivity },
          },
        ],
      });
      return thread.id;
    };
    const recent = async (threadId: string) =>
      (await getRecentChatMessagesForThreadForUser(userId, threadId, 29))!;
    const stored = async (threadId: string) => (await pool.current!.query(
      "SELECT metadata_json FROM chat_messages WHERE thread_id = $1 AND role = 'assistant' ORDER BY position",
      [threadId],
    )).rows.map((row) => row.metadata_json);

    // The generator's explicit empty receipt list survives the save and the reload.
    const threadId = await lookupTurn([]);
    expect((await stored(threadId))[0]).toMatchObject({ contractEvidence: [] });
    expect((await stored(threadId))[0]).not.toHaveProperty("contractEvidenceInvalid");
    const saved = (await recent(threadId)).at(-1)!;
    expect(saved.content).toBe(answer);
    expect(saved.contractEvidence).toEqual([]);
    expect(saved.agentMessages).toEqual(lookups);
    // A followup inherits no dependencies and both turns stay live, even after a later upload.
    const inherited = boundCanonicalChatHistory(await recent(threadId)).flatMap(
      (message) => message.contractEvidence ?? [],
    );
    expect(inherited).toEqual([]);
    await appendChatMessagesToThread({
      userId,
      threadId,
      messages: [
        { role: "user", content: "So what should I do?" },
        {
          role: "assistant",
          content: "Upload a contract first.",
          metadata: { agentMessages: [], contractEvidence: inherited, toolActivity: [] },
        },
      ],
    });
    await createContractForUser({ userId, title: "Uploaded later" });
    const after = await recent(threadId);
    expect(after.map((message) => message.content)).toEqual([
      "Which contracts do I have?",
      answer,
      "So what should I do?",
      "Upload a contract first.",
    ]);
    expect(after[1]?.agentMessages).toEqual(lookups);
    expect((await stored(threadId)).map((metadata) => metadata.contractEvidenceInvalid)).toEqual([
      undefined,
      undefined,
    ]);

    // A tool turn saved without a receipt list cannot vouch for itself.
    const unreceipted = await lookupTurn(undefined);
    expect((await stored(unreceipted))[0]).toMatchObject({ contractEvidenceInvalid: true });
    expect((await stored(unreceipted))[0]).not.toHaveProperty("agentMessages");
    expect((await recent(unreceipted)).at(-1)?.content).toBe(STALE_CONTRACT_REPLY);
    // Legacy rows from before receipts, malformed receipts, and prior verdicts fail closed on read.
    for (const planted of [
      "metadata_json - 'contractEvidence'",
      `jsonb_set(metadata_json, '{contractEvidence}', 'null')`,
      `jsonb_set(metadata_json, '{contractEvidence}', '{}')`,
      `jsonb_set(metadata_json, '{contractEvidence}', '[{"id":"not-a-uuid","revision":"x"}]')`,
      `metadata_json || '{"contractEvidenceInvalid":true}'`,
    ]) {
      const legacy = await lookupTurn([]);
      await pool.current!.query(
        `UPDATE chat_messages SET metadata_json = ${planted} WHERE thread_id = $1 AND role = 'assistant'`,
        [legacy],
      );
      const reply = (await recent(legacy)).at(-1)!;
      expect(reply.content, planted).toBe(STALE_CONTRACT_REPLY);
      expect(reply.agentMessages, planted).toBeUndefined();
      expect(reply.contractEvidence, planted).toBeUndefined();
    }
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

  it("searches every owned contract by title, case-insensitively and with wildcards taken literally", async () => {
    const owner = "search-owner";
    const project = await createProjectForUser({ userId: owner, title: "Property" });
    const standalone = await createContractForUser({ userId: owner, title: "Office LEASE" });
    const inProject = await createContractForUser({
      userId: owner,
      title: "Warehouse lease",
      projectId: project.id,
    });
    await createContractForUser({ userId: owner, title: "Employment agreement" });
    await createContractForUser({ userId: "search-intruder", title: "Intruder lease" });
    const percent = await createContractForUser({ userId: owner, title: "50% discount" });
    await createContractForUser({ userId: owner, title: "500 discount" });
    const underscore = await createContractForUser({ userId: owner, title: "plan_b" });
    await createContractForUser({ userId: owner, title: "planxb" });
    const backslash = await createContractForUser({ userId: owner, title: "C:\\terms" });
    await createContractForUser({ userId: owner, title: "C:terms" });

    // A search ignores the standalone filter, names each result's project, and counts what it matched.
    const leases = await listContractsByUserId(owner, {}, true, "lease");
    expect(leases.total).toBe(2);
    expect(leases.data.map((row) => [row.id, row.projectTitle])).toEqual([
      [inProject.id, "Property"],
      [standalone.id, null],
    ]);
    expect(leases.data.every((row) => row.userId === owner)).toBe(true);
    expect((await listContractsByUserId("search-intruder", {}, false, "lease")).data.map((row) => row.title))
      .toEqual(["Intruder lease"]);

    const only = async (term: string) => {
      const page = await listContractsByUserId(owner, {}, false, term);
      return [page.total, page.data.map((row) => row.id)];
    };
    expect(await only("50%")).toEqual([1, [percent.id]]);
    expect(await only("n_b")).toEqual([1, [underscore.id]]);
    expect(await only("C:\\t")).toEqual([1, [backslash.id]]);
    expect(await only("no such title")).toEqual([0, []]);

    // Without a search the standalone list is unchanged apart from the null project title.
    const standaloneList = await listContractsByUserId(owner, {}, true);
    expect(standaloneList.data.map((row) => row.id)).not.toContain(inProject.id);
    expect(standaloneList.data.every((row) => row.projectTitle === null)).toBe(true);
    expect(standaloneList.total).toBe(8);
  });

  it("pages through more than one page of title search results with the filtered total", async () => {
    const owner = "search-paging-owner";
    await pool.current!.query(
      `insert into contracts (user_id, title, status, created_at)
       select $1, case when n % 2 = 0 then 'Paged lease ' || n else 'Unrelated ' || n end, 'DRAFT',
              now() - n * interval '1 minute'
       from generate_series(1, 110) as n`,
      [owner],
    );

    const first = await listContractsByUserId(owner, { offset: 0 }, true, "PAGED");
    const second = await listContractsByUserId(owner, { offset: 50 }, true, "PAGED");
    expect([first.total, first.data.length, second.total, second.data.length]).toEqual([55, 50, 55, 5]);
    const titles = [...first.data, ...second.data].map((row) => row.title);
    expect(new Set(titles).size).toBe(55);
    expect(titles[0]).toBe("Paged lease 2");
    expect(titles.at(-1)).toBe("Paged lease 110");
  });

  it("searches contract text from 3 code points, says where each contract matched, and returns only a short excerpt", async () => {
    const owner = "text-search-owner";
    const project = await createProjectForUser({ userId: owner, title: "Suppliers" });
    const filler = (word: string) => `${word} `.repeat(150);
    // [title, text, status, minutes ago, in the project]
    const rows: Array<[string, string | null, string, number, boolean]> = [
      [
        "Supplier agreement",
        `START-OF-TEXT ${filler("lorem")}Termination.\n\n   Either party may end it with a 60-day notice period,\tin writing.\r\n${filler("ipsum")} END-OF-TEXT`,
        "ANALYZED", 1, true,
      ],
      ["Renewal terms", "This agreement renews yearly. Renewal needs a 60-DAY NOTICE PERIOD.", "DRAFT", 2, false],
      ["Null text renewal", null, "DRAFT", 3, false],
      ["60 Main St lease", null, "DRAFT", 4, false],
      ["Literal symbols", "Fees: 5%x, a_b and c\\d apply.", "DRAFT", 5, false],
      ["Wildcard lookalikes", "Fees: 5 tax, axb and cd apply.", "DRAFT", 6, false],
      ["Short", "Pay 60 days after notice.", "ANALYZED", 7, false],
    ];
    const ids = new Map<string, string>();
    for (const [title, text, status, minutesAgo, inProject] of rows) {
      const { rows: inserted } = await pool.current!.query<{ id: string }>(
        `insert into contracts (user_id, project_id, title, text_content, status, created_at)
         values ($1, $2, $3, $4, $5, now() - $6 * interval '1 minute')
         returning id`,
        [owner, inProject ? project.id : null, title, text, status, minutesAgo],
      );
      ids.set(title, inserted[0]!.id);
    }
    // Another owner's contract matches the same text and must never appear, nor its text.
    await pool.current!.query(
      `insert into contracts (user_id, title, text_content, status)
       values ($1, 'Intruder contract', 'A 60-day notice period and an intruder-only secret.', 'ANALYZED')`,
      ["text-search-intruder"],
    );

    const search = async (term: string, filters: Parameters<typeof listContractsByUserId>[4] = {}) => {
      // The dashboard asks for standalone contracts; a search spans projects anyway.
      const page = await listContractsByUserId(owner, {}, true, term, filters);
      expect(page.data.every((row) => row.userId === owner)).toBe(true);
      expect(page.total).toBe(page.data.length);
      const serialized = JSON.stringify(page);
      expect(serialized).not.toContain("intruder");
      expect(serialized).not.toContain("START-OF-TEXT");
      expect(serialized).not.toContain("END-OF-TEXT");
      return page;
    };
    const matches = async (term: string, filters: Parameters<typeof listContractsByUserId>[4] = {}) =>
      (await search(term, filters)).data.map((row) => [row.title, row.match?.in]);

    // A phrase only in the text finds the contract, in a project too, with an excerpt around it.
    const notice = await search("60-day notice");
    expect(notice.data.map((row) => [row.title, row.projectTitle, row.match?.in])).toEqual([
      ["Supplier agreement", "Suppliers", "text"],
      ["Renewal terms", null, "text"],
    ]);
    const excerpt = (row: (typeof notice.data)[number]) =>
      row.match?.in === "text" ? row.match.snippet : null;
    const supplier = excerpt(notice.data[0]!)!;
    // The match sits mid-text, so both ends are cut and marked, and whitespace is collapsed.
    expect(supplier).toMatch(
      /^…[lorem ]+ Termination\. Either party may end it with a 60-day notice period, in writing\. [ipsum ]+…$/,
    );
    expect(supplier).not.toMatch(/\s{2}|[\n\r\t]/);
    expect([...supplier].length).toBeLessThanOrEqual(CONTRACT_SEARCH_EXCERPT_LENGTH + 2);
    expect([...supplier].length).toBeGreaterThan(100);
    // A short text is shown whole, with no cut marks; the match keeps the text's own case.
    expect(excerpt(notice.data[1]!)).toBe("This agreement renews yearly. Renewal needs a 60-DAY NOTICE PERIOD.");

    // A title match is reported as one even when the text matches too, and carries no excerpt.
    const renewal = await search("RENEWAL");
    expect(renewal.data.map((row) => [row.title, row.match])).toEqual([
      ["Renewal terms", { in: "title" }],
      ["Null text renewal", { in: "title" }],
    ]);

    // Shorter than 3 code points matches titles only; 3 or more looks in the text too.
    expect(await matches("60")).toEqual([["60 Main St lease", "title"]]);
    expect(await matches("60 ")).toEqual([["60 Main St lease", "title"]]);
    expect(await matches("60-")).toEqual([
      ["Supplier agreement", "text"],
      ["Renewal terms", "text"],
    ]);
    expect(await matches("60 d")).toEqual([["Short", "text"]]);

    // LIKE wildcards and the escape character match literally in the text as in titles.
    expect(await matches("5%x")).toEqual([["Literal symbols", "text"]]);
    expect(await matches("a_b")).toEqual([["Literal symbols", "text"]]);
    expect(await matches("c\\d")).toEqual([["Literal symbols", "text"]]);
    expect(await matches("no such words")).toEqual([]);

    // Filters narrow a text search as they do a title search.
    expect(await matches("notice", { status: "analyzed" })).toEqual([
      ["Supplier agreement", "text"],
      ["Short", "text"],
    ]);
    expect(await matches("notice", { status: "draft", added: "7d" })).toEqual([["Renewal terms", "text"]]);
    expect(await matches("notice", { added: "7d" })).toHaveLength(3);

    // Without a search, rows carry no match and the standalone list is unchanged.
    const list = await listContractsByUserId(owner, {}, true);
    expect(list.data.map((row) => row.title)).toEqual(
      rows.filter(([, , , , inProject]) => !inProject).map(([title]) => title),
    );
    expect(list.data.every((row) => !("match" in row))).toBe(true);
    const filtered = await listContractsByUserId(owner, {}, true, null, { status: "analyzed" });
    expect(filtered.data.every((row) => !("match" in row))).toBe(true);

    // The other owner finds only their own contract.
    const intruder = await listContractsByUserId("text-search-intruder", {}, false, "60-day notice");
    expect(intruder.data.map((row) => [row.title, row.match?.in])).toEqual([["Intruder contract", "text"]]);
    expect(JSON.stringify(intruder)).not.toContain("Supplier");
  });

  it("cuts an excerpt at the start or end of the text without a cut mark there, and widens it for a long search", async () => {
    const owner = "text-search-owner";
    const long = "x".repeat(400);
    const term = `needle ${"y".repeat(190)}`;
    await pool.current!.query(
      `insert into contracts (user_id, title, text_content, created_at) values
         ($1, 'Edge start', $2, now() - interval '1 day'),
         ($1, 'Edge end', $3, now() - interval '1 day 1 minute'),
         ($1, 'Long search', $4, now() - interval '1 day 2 minutes')`,
      [owner, `edgestartword ${long}`, `${long} edgeendword`, `${long} ${term} ${long}`],
    );
    const snippet = async (search: string) => {
      const page = await listContractsByUserId(owner, {}, false, search);
      expect(page.data).toHaveLength(1);
      const match = page.data[0]!.match;
      if (match?.in !== "text") throw new Error("expected a text match");
      return match.snippet;
    };

    const start = await snippet("edgestartword");
    expect(start.startsWith("edgestartword ")).toBe(true);
    expect(start.endsWith("x…")).toBe(true);
    expect([...start].length).toBe(CONTRACT_SEARCH_EXCERPT_LENGTH + 1);

    const end = await snippet("edgeendword");
    expect(end.startsWith("…x")).toBe(true);
    expect(end.endsWith(" edgeendword")).toBe(true);
    expect([...end].length).toBe(CONTRACT_SEARCH_EXCERPT_LENGTH + 1);

    // A search longer than the usual excerpt still fits whole, and the excerpt stays bounded.
    const longMatch = await snippet(term);
    expect(longMatch).toBe(`…${term}…`);
    expect([...longMatch].length).toBeLessThanOrEqual(MAX_CONTRACT_SEARCH_LENGTH + 2);
  });

  it("pages through mixed title and text matches with the matching total and no duplicates or gaps", async () => {
    const owner = "text-search-paging-owner";
    // 120 contracts a minute apart: every third has the term in its title, the next in its text only.
    await pool.current!.query(
      `insert into contracts (user_id, title, text_content, created_at)
       select $1,
              case when n % 3 = 0 then 'Paged title ' || n else 'Contract ' || n end,
              case when n % 3 = 1 then 'Clause ' || n || ' is PAGED here.' when n % 3 = 0 then 'paged too' else 'nothing' end,
              now() - n * interval '1 minute'
       from generate_series(1, 120) as n`,
      [owner],
    );

    const first = await listContractsByUserId(owner, { offset: 0 }, true, "paged");
    const second = await listContractsByUserId(owner, { offset: 50 }, true, "paged");
    expect([first.total, first.data.length, second.total, second.data.length]).toEqual([80, 50, 80, 30]);
    const rows = [...first.data, ...second.data];
    expect(new Set(rows.map((row) => row.id)).size).toBe(80);
    const expected = Array.from({ length: 120 }, (_, index) => index + 1)
      .filter((n) => n % 3 !== 2)
      .map((n) => (n % 3 === 0 ? [`Paged title ${n}`, "title"] : [`Contract ${n}`, "text"]));
    expect(rows.map((row) => [row.title, row.match?.in])).toEqual(expected);
    const textRow = rows.find((row) => row.title === "Contract 1")!;
    expect(textRow.match).toEqual({ in: "text", snippet: "Clause 1 is PAGED here." });
  });

  it("filters every owned contract by analysis status and added date, alone or with a title search", async () => {
    const owner = "filter-owner";
    const project = await createProjectForUser({ userId: owner, title: "Property" });
    // [title, status, days ago, in the project]
    const rows: Array<[string, string, number, boolean]> = [
      ["Fresh lease", "ANALYZED", 0, false],
      ["Fresh draft lease", "DRAFT", 3, true],
      ["Month-old agreement", "ANALYZED", 20, true],
      ["Month-old lease draft", "DRAFT", 29, false],
      ["Old lease", "ANALYZED", 100, false],
      ["Ancient draft", "DRAFT", 400, false],
    ];
    const ids = new Map<string, string>();
    for (const [title, status, daysAgo, inProject] of rows) {
      const { rows: inserted } = await pool.current!.query<{ id: string }>(
        `insert into contracts (user_id, project_id, title, status, created_at)
         values ($1, $2, $3, $4, now() - $5 * interval '1 day')
         returning id`,
        [owner, inProject ? project.id : null, title, status, daysAgo],
      );
      ids.set(title, inserted[0]!.id);
    }
    // Another owner's contracts match every filter and must never appear.
    await pool.current!.query(
      `insert into contracts (user_id, title, status) values ($1, 'Intruder lease', 'ANALYZED'), ($1, 'Intruder draft', 'DRAFT')`,
      ["filter-intruder"],
    );

    const titles = async (filters: Parameters<typeof listContractsByUserId>[4], search: string | null = null) => {
      // The dashboard asks for standalone contracts; a filter spans projects anyway.
      const page = await listContractsByUserId(owner, {}, true, search, filters);
      expect(page.data.every((row) => row.userId === owner)).toBe(true);
      expect(page.total).toBe(page.data.length);
      return page.data.map((row) => row.title);
    };

    expect(await titles({ status: "analyzed" })).toEqual(["Fresh lease", "Month-old agreement", "Old lease"]);
    expect(await titles({ status: "draft" })).toEqual(["Fresh draft lease", "Month-old lease draft", "Ancient draft"]);
    expect(await titles({ added: "7d" })).toEqual(["Fresh lease", "Fresh draft lease"]);
    expect(await titles({ added: "30d" })).toEqual([
      "Fresh lease", "Fresh draft lease", "Month-old agreement", "Month-old lease draft",
    ]);
    expect(await titles({ added: "365d" })).toEqual([
      "Fresh lease", "Fresh draft lease", "Month-old agreement", "Month-old lease draft", "Old lease",
    ]);
    expect(await titles({ status: "draft", added: "30d" })).toEqual(["Fresh draft lease", "Month-old lease draft"]);
    expect(await titles({ status: "draft", added: "30d" }, "LEASE DRAFT")).toEqual(["Month-old lease draft"]);
    expect(await titles({ status: "analyzed", added: "7d" }, "agreement")).toEqual([]);
    // Results filed in a project name it.
    const inProject = await listContractsByUserId(owner, {}, true, null, { status: "draft", added: "7d" });
    expect(inProject.data.map((row) => [row.id, row.projectTitle])).toEqual([
      [ids.get("Fresh draft lease"), "Property"],
    ]);

    // Without filters the standalone list is unchanged; empty filters are no filters.
    const standalone = ["Fresh lease", "Month-old lease draft", "Old lease", "Ancient draft"];
    expect(await titles({})).toEqual(standalone);
    expect(await titles({ status: null, added: null })).toEqual(standalone);
    expect((await listContractsByUserId("filter-intruder", {}, false, null, { status: "draft" })).data.map((row) => row.title))
      .toEqual(["Intruder draft"]);
  });

  it("pages through more than one page of filtered contracts with the filtered total", async () => {
    const owner = "filter-paging-owner";
    // 120 contracts a day apart; the even-numbered ones are analyzed.
    await pool.current!.query(
      `insert into contracts (user_id, title, status, created_at)
       select $1, 'Contract ' || n, case when n % 2 = 0 then 'ANALYZED' else 'DRAFT' end,
              now() - n * interval '1 day' + interval '1 hour'
       from generate_series(1, 120) as n`,
      [owner],
    );

    const first = await listContractsByUserId(owner, { offset: 0 }, true, null, { status: "analyzed" });
    const second = await listContractsByUserId(owner, { offset: 50 }, true, null, { status: "analyzed" });
    expect([first.total, first.data.length, second.total, second.data.length]).toEqual([60, 50, 60, 10]);
    const seen = [...first.data, ...second.data].map((row) => row.title);
    expect(new Set(seen).size).toBe(60);
    expect(seen[0]).toBe("Contract 2");
    expect(seen.at(-1)).toBe("Contract 120");

    // Contracts 1-30 fall in the last 30 days (each is n days old less an hour); 15 are drafts.
    const recentDrafts = await listContractsByUserId(owner, { limit: 10 }, true, null, { status: "draft", added: "30d" });
    expect([recentDrafts.total, recentDrafts.data.length]).toEqual([15, 10]);
    expect(recentDrafts.data[0]?.title).toBe("Contract 1");
  });

  it("searches the owner's projects by title, case-insensitively and with wildcards taken literally", async () => {
    const owner = "project-search-owner";
    const older = await createProjectForUser({ userId: owner, title: "Office LEASES" });
    const newer = await createProjectForUser({ userId: owner, title: "Warehouse leases" });
    await createProjectForUser({ userId: owner, title: "Employment" });
    await createProjectForUser({ userId: "project-search-intruder", title: "Intruder leases" });
    const percent = await createProjectForUser({ userId: owner, title: "50% renewals" });
    await createProjectForUser({ userId: owner, title: "500 renewals" });
    const underscore = await createProjectForUser({ userId: owner, title: "plan_b" });
    await createProjectForUser({ userId: owner, title: "planxb" });
    const backslash = await createProjectForUser({ userId: owner, title: "C:\\deals" });
    await createProjectForUser({ userId: owner, title: "C:deals" });

    // Matches keep the list's newest-first order and count only what matched.
    const leases = await listProjectsByUserId(owner, {}, "lease");
    expect(leases.total).toBe(2);
    expect(leases.data.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(leases.data.every((row) => row.userId === owner)).toBe(true);
    expect((await listProjectsByUserId("project-search-intruder", {}, "lease")).data.map((row) => row.title))
      .toEqual(["Intruder leases"]);

    const only = async (term: string) => {
      const page = await listProjectsByUserId(owner, {}, term);
      return [page.total, page.data.map((row) => row.id)];
    };
    expect(await only("50%")).toEqual([1, [percent.id]]);
    expect(await only("n_b")).toEqual([1, [underscore.id]]);
    expect(await only("C:\\d")).toEqual([1, [backslash.id]]);
    expect(await only("no such title")).toEqual([0, []]);

    // Without a search the list is unchanged.
    expect((await listProjectsByUserId(owner, {})).total).toBe(9);
    expect((await listProjectsByUserId(owner, {}, null)).total).toBe(9);
  });

  it("pages through more than one page of project search results with the filtered total", async () => {
    const owner = "project-search-paging-owner";
    await pool.current!.query(
      `insert into projects (user_id, title, created_at)
       select $1, case when n % 2 = 0 then 'Paged deal ' || n else 'Unrelated ' || n end,
              now() - n * interval '1 minute'
       from generate_series(1, 110) as n`,
      [owner],
    );

    const first = await listProjectsByUserId(owner, { offset: 0 }, "PAGED");
    const second = await listProjectsByUserId(owner, { offset: 50 }, "PAGED");
    expect([first.total, first.data.length, second.total, second.data.length]).toEqual([55, 50, 55, 5]);
    const titles = [...first.data, ...second.data].map((row) => row.title);
    expect(new Set(titles).size).toBe(55);
    expect(titles[0]).toBe("Paged deal 2");
    expect(titles.at(-1)).toBe("Paged deal 110");
  });

  it("searches the owner's chats by title, case-insensitively and with wildcards taken literally", async () => {
    const owner = "chat-search-owner";
    const create = async (title: string, minutesAgo: number, userId = owner) => {
      const thread = await createChatThreadForUser({ userId, title });
      await pool.current!.query(
        "update chat_threads set updated_at = now() - $2 * interval '1 minute' where id = $1",
        [thread.id, minutesAgo],
      );
      return thread;
    };
    const older = await create("Office LEASES", 10);
    const newer = await create("Warehouse leases", 1);
    await create("Employment", 2);
    await create("Intruder leases", 0, "chat-search-intruder");
    const percent = await create("50% renewals", 3);
    await create("500 renewals", 4);
    const underscore = await create("plan_b", 5);
    await create("planxb", 6);
    const backslash = await create("C:\\deals", 7);
    await create("C:deals", 8);

    // Matches keep the list's most-recently-updated-first order and count only what matched.
    const leases = await listChatThreadsByUserId(owner, {}, "lease");
    expect(leases.total).toBe(2);
    expect(leases.data.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(leases.data.every((row) => row.userId === owner)).toBe(true);
    expect((await listChatThreadsByUserId("chat-search-intruder", {}, "lease")).data.map((row) => row.title))
      .toEqual(["Intruder leases"]);

    const only = async (term: string) => {
      const page = await listChatThreadsByUserId(owner, {}, term);
      return [page.total, page.data.map((row) => row.id)];
    };
    expect(await only("50%")).toEqual([1, [percent.id]]);
    expect(await only("n_b")).toEqual([1, [underscore.id]]);
    expect(await only("C:\\d")).toEqual([1, [backslash.id]]);
    expect(await only("no such title")).toEqual([0, []]);

    // Without a search the list is unchanged.
    expect((await listChatThreadsByUserId(owner, {})).total).toBe(9);
    expect((await listChatThreadsByUserId(owner, {}, null)).total).toBe(9);
  });

  it("pages through more than one page of chat search results with the filtered total", async () => {
    const owner = "chat-search-paging-owner";
    await pool.current!.query(
      `insert into chat_threads (user_id, title, updated_at)
       select $1, case when n % 2 = 0 then 'Paged chat ' || n else 'Unrelated ' || n end,
              now() - n * interval '1 minute'
       from generate_series(1, 110) as n`,
      [owner],
    );

    const first = await listChatThreadsByUserId(owner, { offset: 0 }, "PAGED");
    const second = await listChatThreadsByUserId(owner, { offset: 50 }, "PAGED");
    expect([first.total, first.data.length, second.total, second.data.length]).toEqual([55, 50, 55, 5]);
    const titles = [...first.data, ...second.data].map((row) => row.title);
    expect(new Set(titles).size).toBe(55);
    expect(titles[0]).toBe("Paged chat 2");
    expect(titles.at(-1)).toBe("Paged chat 110");
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
  // Retry-After is the wait until the limiting window resets plus 0-15 s of jitter; resetAt has none.
  function expectRejection(
    result: AdmissionResult,
    reason: "busy" | "hourly" | "daily",
    maxWaitSeconds: number,
  ) {
    expect(result).toMatchObject({ reason, resetAt: expect.any(String) });
    if (!("retryAfter" in result)) throw new Error("expected a rejection");
    const wait = (Date.parse(result.resetAt) - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThanOrEqual(maxWaitSeconds);
    expect(Number.isInteger(result.retryAfter)).toBe(true);
    expect(result.retryAfter).toBeGreaterThanOrEqual(
      Math.max(1, Math.floor(wait)),
    );
    expect(result.retryAfter).toBeLessThanOrEqual(Math.ceil(wait) + 16);
    return result;
  }

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
    const rejected = claims.filter((c) => "retryAfter" in c);
    expect(rejected).toHaveLength(4);
    for (const rejection of rejected) expectRejection(rejection, "busy", 30);
    await accepted[0]!.release();
    const second = await claimChatAdmission(input);
    expect(second).toHaveProperty("release");
    if ("release" in second) await second.release();
    const hourly = expectRejection(
      await claimChatAdmission(input),
      "hourly",
      3600,
    );
    expect(Date.parse(hourly.resetAt) % 1000).toBe(0);
    expect(hourly.quota).toMatchObject({
      used: 2,
      remaining: 0,
      resetAt: hourly.resetAt,
    });
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
    expectRejection(
      await claimChatAdmission({ ...input, principal: "two" }),
      "busy",
      30,
    );
    if ("release" in first) await first.release();
    const second = await claimChatAdmission({ ...input, principal: "two" });
    if ("release" in second) await second.release();
    const daily = expectRejection(
      await claimChatAdmission({ ...input, principal: "three" }),
      "daily",
      86400,
    );
    const today = new Date();
    expect(daily.resetAt).toBe(
      new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() + 1,
        ),
      ).toISOString(),
    );
  });

  it("asks a busy caller to wait only until its earliest slot expires", async () => {
    await pool.current!.query("TRUNCATE chat_admissions, chat_request_budgets");
    const input = {
      principal: "abandoned",
      hourlyLimit: 10,
      concurrency: 1,
      globalDailyLimit: 20,
      globalConcurrency: 8,
    };
    const held = await claimChatAdmission(input);
    await pool.current!.query(
      "UPDATE chat_admissions SET expires_at = now() + interval '5 seconds'",
    );
    expectRejection(await claimChatAdmission(input), "busy", 5);
    if ("release" in held) await held.release();
  });

  it("reports the quota claims enforce without locking, pruning, or writing", async () => {
    await pool.current!.query("TRUNCATE chat_admissions, chat_request_budgets");
    const userId = "quota-owner";
    const limits = admissionLimits(userId);
    const granted = async () => {
      const result = await claimChatAdmission(limits);
      if (!("release" in result)) throw new Error("expected admission");
      return result;
    };
    const tables = async () =>
      (
        await pool.current!.query(
          `SELECT (SELECT json_agg(a ORDER BY a.token) FROM chat_admissions a) AS admissions,
            (SELECT json_agg(b ORDER BY b.bucket, b.window_start) FROM chat_request_budgets b) AS budgets`,
        )
      ).rows[0];

    const idle = await getInferenceQuota(userId);
    expect(idle).toEqual({
      account: {
        limit: 30,
        used: 0,
        remaining: 30,
        resetAt: expect.any(String),
        concurrency: { limit: 2, inUse: 0 },
      },
      service: "ok",
    });
    expect(await tables()).toEqual({ admissions: null, budgets: null });

    const first = await granted();
    const second = await granted();
    expect(second.quota).toMatchObject({
      used: 2,
      remaining: 28,
      concurrency: { inUse: 2 },
    });
    expect((await getInferenceQuota(userId)).account).toEqual(second.quota);
    const busy = expectRejection(await claimChatAdmission(limits), "busy", 30);
    expect(busy.quota).toEqual(second.quota);

    await first.release();
    expect((await getInferenceQuota(userId)).account).toMatchObject({
      used: 2,
      remaining: 28,
      concurrency: { inUse: 1 },
    });
    const third = await granted();
    expect((await getInferenceQuota(userId)).account).toEqual(third.quota);
    await second.release();
    await third.release();
    expect((await getInferenceQuota(userId)).account).toMatchObject({
      used: 3,
      remaining: 27,
      concurrency: { inUse: 0 },
    });

    // Claims prune expired slots and old windows under the admission lock; a report does neither
    // and must not wait for that lock.
    await pool.current!.query(
      "INSERT INTO chat_admissions(token, principal, expires_at) VALUES (gen_random_uuid(), $1, now() - interval '1 second')",
      [limits.principal],
    );
    await pool.current!.query(
      "INSERT INTO chat_request_budgets(bucket, window_start, requests) VALUES ($1, date_trunc('hour', now()) - interval '3 days', 9)",
      [limits.principal],
    );
    const before = await tables();
    const holder = await pool.current!.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(736194822)");
      expect((await getInferenceQuota(userId)).account).toMatchObject({
        used: 3,
        concurrency: { inUse: 0 },
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(await tables()).toEqual(before);

    await pool.current!.query(
      "UPDATE chat_request_budgets SET requests = $2 WHERE bucket = $1 AND window_start = date_trunc('hour', now())",
      [limits.principal, limits.hourlyLimit],
    );
    expect((await getInferenceQuota(userId)).account).toMatchObject({
      used: 30,
      remaining: 0,
    });
    expect(
      expectRejection(await claimChatAdmission(limits), "hourly", 3600).quota,
    ).toEqual((await getInferenceQuota(userId)).account);

    // Service-wide state surfaces only as a coarse status.
    await pool.current!.query(
      "INSERT INTO chat_admissions(token, principal, expires_at) SELECT gen_random_uuid(), 'other-' || n, now() + interval '1 minute' FROM generate_series(1, $1) n",
      [limits.globalConcurrency],
    );
    expect((await getInferenceQuota(userId)).service).toBe("busy");
    await pool.current!.query(
      "UPDATE chat_request_budgets SET requests = $1 WHERE bucket = 'global' AND window_start = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
      [limits.globalDailyLimit],
    );
    expect(await getInferenceQuota(userId)).toMatchObject({
      account: { used: 30, concurrency: { inUse: 0 } },
      service: "exhausted",
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
    await pool.current!.query("TRUNCATE storage_deletions CASCADE");
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
    await pool.current!.query("TRUNCATE storage_deletions CASCADE");
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

  it("binds direct-upload intents to the owner's target and keeps them for cleanup", async () => {
    const item = await contract();
    const project = await createProjectForUser({ userId: "owner", title: "Direct" });
    const pathname = `uploads/${crypto.randomUUID()}`;
    const cleanupKey = `blob:${pathname}`;
    const target = { kind: "contract", id: item.id } as const;
    const intents = async (key: string) =>
      (
        await pool.current!.query<{ id: string; due: boolean }>(
          "SELECT id, available_at > now() + interval '59 minutes' AS due FROM storage_deletions WHERE storage_key = $1",
          [key],
        )
      ).rows;

    expect(
      await createDirectUploadIntent({ userId: "intruder", pathname, cleanupKey, target }),
    ).toBeNull();
    expect(await intents(cleanupKey)).toEqual([]);

    const created = await createDirectUploadIntent({ userId: "owner", pathname, cleanupKey, target });
    if (!created || created === "conflict") throw new Error("expected an intent");
    // Not due for an hour, so the outbox removes an abandoned upload only after that.
    expect(await intents(cleanupKey)).toEqual([{ id: created.id, due: true }]);

    // A second token for an unclaimed pathname would add an intent that outlives the first claim.
    expect(
      await createDirectUploadIntent({
        userId: "owner", pathname, cleanupKey, target: { kind: "project", id: project.id },
      }),
    ).toBe("conflict");
    expect(await intents(cleanupKey)).toHaveLength(1);

    expect(await findDirectUploadIntent({ userId: "owner", pathname, target })).toBe(created.id);
    expect(await findDirectUploadIntent({ userId: "intruder", pathname, target })).toBeNull();
    expect(
      await findDirectUploadIntent({ userId: "owner", pathname, target: { kind: "project", id: project.id } }),
    ).toBeNull();
    expect(
      await findDirectUploadIntent({ userId: "owner", pathname: `uploads/${crypto.randomUUID()}`, target }),
    ).toBeNull();
    await pool.current!.query(
      "UPDATE storage_deletions SET lease_token = gen_random_uuid() WHERE id = $1",
      [created.id],
    );
    expect(await findDirectUploadIntent({ userId: "owner", pathname, target })).toBeNull();
    await pool.current!.query(
      "UPDATE storage_deletions SET lease_token = NULL WHERE id = $1",
      [created.id],
    );

    expect(
      await saveContractUploadForUser({
        userId: "owner",
        contractId: item.id,
        projectId: null,
        title: "Direct",
        fileName: "scan.pdf",
        storageKey: `https://store.private.blob.vercel-storage.com/${pathname}`,
        storageIntentId: created.id,
        bucket: "vercel-blob",
        contentType: "application/pdf",
        sizeBytes: 9 * 1024 * 1024,
        text: "finalized",
        extractionMethod: "pdf_parse",
        extractionConfidence: 100,
      }),
    ).toBe(true);
    expect(await intents(cleanupKey)).toEqual([]);
    expect(await findDirectUploadIntent({ userId: "owner", pathname, target })).toBeNull();
    expect(
      (await pool.current!.query("SELECT 1 FROM direct_uploads WHERE pathname = $1", [pathname])).rowCount,
    ).toBe(0);

    // Deleting the target drops the binding but keeps the intent, so the blob is still removed.
    const projectPathname = `uploads/${crypto.randomUUID()}`;
    const projectTarget = { kind: "project", id: project.id } as const;
    const pending = await createDirectUploadIntent({
      userId: "owner", pathname: projectPathname, cleanupKey: `blob:${projectPathname}`, target: projectTarget,
    });
    if (!pending || pending === "conflict") throw new Error("expected an intent");
    await deleteProjectForUser({ userId: "owner", projectId: project.id });
    expect(await intents(`blob:${projectPathname}`)).toEqual([{ id: pending.id, due: true }]);
    expect(
      (await pool.current!.query("SELECT 1 FROM direct_uploads WHERE pathname = $1", [projectPathname])).rowCount,
    ).toBe(0);
    expect(
      await createDirectUploadIntent({
        userId: "owner", pathname: `uploads/${crypto.randomUUID()}`, cleanupKey: "blob:x", target: projectTarget,
      }),
    ).toBeNull();
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

  it("deletes every row an account owns and queues its stored objects, leaving other accounts intact", async () => {
    async function seed() {
      const userId = await resolveWorkOSUserId({ id: `user_${crypto.randomUUID()}` });
      const { principal } = admissionLimits(userId);
      const project = await createProjectForUser({ userId, title: "Lease" });
      const contextKey = `account-context-${crypto.randomUUID()}`;
      await addContextDocumentToProject({
        userId, projectId: project.id, title: "Brief", documentType: "other", storageKey: contextKey,
        bucket: "test", originalFilename: "brief.txt", contentType: "text/plain", sizeBytes: 5,
        extractedText: "Brief", wordCount: 1,
      });
      const contracts = [
        await createContractForUser({ userId, title: "In project", projectId: project.id }),
        await createContractForUser({ userId, title: "Loose" }),
      ];
      const fileKeys: string[] = [];
      for (const item of contracts) {
        const storageKey = `account-file-${crypto.randomUUID()}`;
        fileKeys.push(storageKey);
        await saveContractUploadForUser({
          userId, contractId: item.id, projectId: item.projectId, title: item.title,
          fileName: "agreement.txt", storageKey, bucket: "test", contentType: "text/plain",
          sizeBytes: 12, extractionMethod: null, extractionConfidence: null, text: "Clause text.",
        });
        const snapshot = await getContractWithLatestAnalysisForUser(userId, item.id);
        await createAnalysisForContract({
          userId, contractId: item.id, expectedRevision: snapshot!.revision, riskBadge: "LOW",
          resultJson: result, llmProvider: "test", llmModel: "test",
        });
        expect(await saveContractNotesForUser(userId, item.id, { acceptanceReasons: "Fair", openQuestions: "Deposit?" }, null))
          .toMatchObject({ status: "saved" });
      }
      // A legacy file row: no contract, and its object key in blob_path.
      const legacyKey = `account-legacy-${crypto.randomUUID()}`;
      await pool.current!.query(
        "INSERT INTO contract_files(user_id, file_name, blob_path) VALUES ($1, 'old.pdf', $2)",
        [userId, legacyKey],
      );
      const thread = await createChatThreadForUser({ userId });
      await appendChatMessagesToThread({ userId, threadId: thread.id, messages: [
        { role: "user", content: "Summarize" },
        { role: "assistant", content: "Summary" },
      ] });
      const document = { id: crypto.randomUUID(), name: "notes.txt", mediaType: "text/plain", size: 5, text: "Notes" };
      await saveChatFileForUser({ userId, threadId: thread.id, file: document, data: Buffer.from(document.text) });
      await pool.current!.query(
        "INSERT INTO chat_attachments(thread_id, image_data) VALUES ($1, $2)",
        [thread.id, Buffer.from("png")],
      );
      await upsertUserSettings({ userId, personality: "bare-llm" });
      expect(await claimGenerationOperation(userId, "contract", contracts[0]!.id, 60)).toBeTypeOf("function");
      expect(await claimGenerationOperation(userId, "chat", thread.id, 60)).toBeTypeOf("function");
      await pool.current!.query(
        "INSERT INTO chat_admissions(token, principal, expires_at) VALUES ($1, $2, now() + interval '1 minute')",
        [crypto.randomUUID(), principal],
      );
      await pool.current!.query(
        "INSERT INTO chat_request_budgets(bucket, window_start, requests) VALUES ($1, date_trunc('hour', now()), 1)",
        [principal],
      );
      return {
        userId, principal, projectIds: [project.id], threadIds: [thread.id],
        contractIds: contracts.map((item) => item.id), storageKeys: [contextKey, ...fileKeys, legacyKey],
      };
    }
    type Account = Awaited<ReturnType<typeof seed>>;

    async function count(table: string, where: string, values: unknown[]) {
      const { rows } = await pool.current!.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM ${table} WHERE ${where}`, values,
      );
      return rows[0]!.count;
    }
    const rowsOf = async (account: Account) => ({
      projects: await count("projects", "user_id = $1", [account.userId]),
      contracts: await count("contracts", "user_id = $1", [account.userId]),
      contractsById: await count("contracts", "id = ANY($1::uuid[])", [account.contractIds]),
      analyses: await count("analyses", "contract_id = ANY($1::uuid[])", [account.contractIds]),
      contractFiles: await count("contract_files", "user_id = $1", [account.userId]),
      contractNotes: await count("contract_notes", "contract_id = ANY($1::uuid[])", [account.contractIds]),
      contextDocuments: await count("context_documents", "project_id = ANY($1::uuid[])", [account.projectIds]),
      threads: await count("chat_threads", "user_id = $1", [account.userId]),
      messages: await count("chat_messages", "thread_id = ANY($1::uuid[])", [account.threadIds]),
      attachments: await count("chat_attachments", "thread_id = ANY($1::uuid[])", [account.threadIds]),
      chatFiles: await count("chat_files", "thread_id = ANY($1::uuid[])", [account.threadIds]),
      settings: await count("user_settings", "user_id = $1", [account.userId]),
      leases: await count("generation_operations", "entity_key LIKE '%:' || $1 || ':%'", [account.userId]),
      admissions: await count("chat_admissions", "principal = $1", [account.principal]),
      budgets: await count("chat_request_budgets", "bucket = $1", [account.principal]),
      identities: await count("auth_identities", "user_id = $1", [account.userId]),
      users: await count("application_users", "id = $1", [account.userId]),
    });
    const queued = async (account: Account) =>
      (await pool.current!.query<{ storage_key: string }>(
        "SELECT DISTINCT storage_key FROM storage_deletions WHERE storage_key = ANY($1)",
        [account.storageKeys],
      )).rows.map((row) => row.storage_key).sort();

    const deleted = await seed();
    const kept = await seed();
    const keptBefore = await rowsOf(kept);
    expect(Object.values(keptBefore).every((rows) => rows > 0)).toBe(true);
    expect(await queued(deleted)).toEqual([]);

    // Data first: the login mapping stays until WorkOS has deleted the user.
    await deleteAccountForUser(deleted.userId, { keepLogin: true });
    const { identities, users, ...data } = await rowsOf(deleted);
    expect({ identities, users }).toEqual({ identities: 1, users: 1 });
    expect(Object.values(data).every((rows) => rows === 0)).toBe(true);

    // A write already under way when the final deletion starts is waited for and swept.
    const late = await pool.current!.connect();
    let lateContractId: string;
    try {
      await late.query("BEGIN");
      await late.query("SELECT id FROM application_users WHERE id = $1 FOR SHARE", [deleted.userId]);
      lateContractId = (await late.query<{ id: string }>(
        "INSERT INTO contracts(user_id, title) VALUES ($1, 'Late') RETURNING id", [deleted.userId],
      )).rows[0]!.id;
      const deletion = deleteAccountForUser(deleted.userId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await late.query("COMMIT");
      await deletion;
    } finally {
      late.release();
    }
    expect(await count("contracts", "id = $1", [lateContractId])).toBe(0);
    // A request that resolved the owner before the deletion cannot recreate data after it.
    await expect(createContractForUser({ userId: deleted.userId, title: "After" })).rejects.toThrow();
    await expect(createProjectForUser({ userId: deleted.userId, title: "After" })).rejects.toThrow();
    await expect(createChatThreadForUser({ userId: deleted.userId })).rejects.toThrow();
    await expect(upsertUserSettings({ userId: deleted.userId, personality: "bare-llm" })).rejects.toThrow();

    const remaining = await rowsOf(deleted);
    expect(remaining).toEqual(Object.fromEntries(Object.keys(remaining).map((key) => [key, 0])));
    // No text column anywhere holds the owner ID any more.
    const { rows: columns } = await pool.current!.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type IN ('text', 'character varying')`,
    );
    expect(columns.length).toBeGreaterThan(10);
    for (const { table_name, column_name } of columns) {
      expect(await count(`"${table_name}"`, `"${column_name}" = $1`, [deleted.userId]), `${table_name}.${column_name}`).toBe(0);
    }
    expect(await queued(deleted)).toEqual([...deleted.storageKeys].sort());

    expect(await rowsOf(kept)).toEqual(keptBefore);
    expect(await queued(kept)).toEqual([]);

    // Idempotent: a repeat finds nothing left and succeeds.
    await expect(deleteAccountForUser(deleted.userId)).resolves.toBeUndefined();
    expect(await rowsOf(kept)).toEqual(keptBefore);
  });

  it("exports exactly one account's rows and files, without operational rows or storage keys", async () => {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signloop-export-"));
    vi.stubEnv("LOCAL_STORAGE_PATH", storageRoot);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    async function store(prefix: string, bytes: Buffer) {
      const storageKey = `${prefix}-${crypto.randomUUID()}`;
      await fs.writeFile(path.join(storageRoot, storageKey), bytes);
      return storageKey;
    }
    async function seed() {
      const userId = await resolveWorkOSUserId({ id: `user_${crypto.randomUUID()}` });
      const { principal } = admissionLimits(userId);
      const tag = crypto.randomUUID();
      const project = await createProjectForUser({ userId, title: `Project ${tag}` });
      const contextBytes = Buffer.from(`Context ${tag}`);
      const contextKey = await store("export-context", contextBytes);
      const contextDocument = await addContextDocumentToProject({
        userId, projectId: project.id, title: "Brief", documentType: "other", storageKey: contextKey,
        bucket: "test", originalFilename: "../brief.txt", contentType: "text/plain",
        sizeBytes: contextBytes.length, extractedText: "Brief", wordCount: 1,
      });
      const contract = await createContractForUser({ userId, title: "Lease", projectId: project.id });
      await setContractJurisdictionForUser({ userId, contractId: contract.id, jurisdiction: `Ontario ${tag}` });
      const uploads: Buffer[] = [];
      // Two uploads with one name: both originals are exported, the second renamed.
      for (const text of ["First lease.", "Second lease."]) {
        const bytes = Buffer.from(text);
        uploads.push(bytes);
        await saveContractUploadForUser({
          userId, contractId: contract.id, projectId: project.id, title: "Lease", fileName: "lease.txt",
          storageKey: await store("export-file", bytes), bucket: "test", contentType: "text/plain",
          sizeBytes: bytes.length, extractionMethod: null, extractionConfidence: null, text,
        });
      }
      const snapshot = await getContractWithLatestAnalysisForUser(userId, contract.id);
      await createAnalysisForContract({
        userId, contractId: contract.id, expectedRevision: snapshot!.revision, riskBadge: "LOW",
        resultJson: { summary: `Analysis ${tag}` }, llmProvider: "test", llmModel: "test",
      });
      const notes = { acceptanceReasons: `Accept ${tag}`, openQuestions: `Ask ${tag}` };
      expect(await saveContractNotesForUser(userId, contract.id, notes, null)).toMatchObject({ status: "saved" });
      // A contract without notes exports null.
      const unnoted = await createContractForUser({ userId, title: "Unnoted" });
      const thread = await createChatThreadForUser({ userId, title: "Questions" });
      const webSources = [{ number: 1, title: "Source", url: "https://source.test" }];
      await appendChatMessagesToThread({ userId, threadId: thread.id, messages: [
        { role: "user", content: "Draw it" },
        {
          role: "assistant",
          content: `![Generated image](data:image/png;base64,${png.toString("base64")})`,
          metadata: { agentMessages: [{ role: "assistant", content: [{ type: "text", text: "private replay" }] }], webSources },
        },
      ] });
      const chatBytes = Buffer.from(`Notes ${tag}`);
      const chatFile = { id: crypto.randomUUID(), name: "notes.txt", mediaType: "text/plain", size: chatBytes.length, text: "Notes" };
      await saveChatFileForUser({ userId, threadId: thread.id, file: chatFile, data: chatBytes });
      await upsertUserSettings({ userId, personality: "bare-llm" });
      expect(await claimGenerationOperation(userId, "contract", contract.id, 60)).toBeTypeOf("function");
      await pool.current!.query(
        "INSERT INTO chat_admissions(token, principal, expires_at) VALUES ($1, $2, now() + interval '1 minute')",
        [crypto.randomUUID(), principal],
      );
      return { userId, principal, tag, project, contextDocument, contextBytes, contract, unnoted, notes, uploads, thread, chatFile, chatBytes, webSources };
    }

    try {
      const owner = await seed();
      const other = await seed();
      const data = await getAccountExportForUser(owner.userId);

      expect(data.projects.map((row) => row.id)).toEqual([owner.project.id]);
      expect(data.contextDocuments.map((row) => row.id)).toEqual([owner.contextDocument.id]);
      expect(data.contracts.map((row) => [row.id, row.textContent])).toEqual([
        [owner.contract.id, "Second lease."],
        [owner.unnoted.id, null],
      ]);
      expect(data.contracts[0]).toMatchObject({ confirmedJurisdiction: `Ontario ${owner.tag}` });
      expect(data.contracts[0]!.jurisdictionConfirmedAt).toBeTruthy();
      expect(data.contractFiles.map((row) => row.contractId)).toEqual([owner.contract.id, owner.contract.id]);
      expect(data.contractNotes).toEqual([
        { contractId: owner.contract.id, ...owner.notes, createdAt: expect.any(Date), updatedAt: expect.any(Date) },
      ]);
      expect(data.analyses.map((row) => [row.contractId, row.resultJson])).toEqual([
        [owner.contract.id, { summary: `Analysis ${owner.tag}` }],
      ]);
      expect(data.chatThreads.map((row) => row.id)).toEqual([owner.thread.id]);
      expect(data.chatMessages.map((row) => row.role)).toEqual(["user", "assistant"]);
      expect(data.chatMessages[1]!.webSources).toEqual(owner.webSources);
      expect(data.chatMessages[1]).not.toHaveProperty("agentMessages");
      expect(data.chatFiles.map((row) => [row.id, row.sizeBytes])).toEqual([[owner.chatFile.id, owner.chatBytes.length]]);
      expect(data.chatImages).toHaveLength(1);
      expect(data.settings).toMatchObject({ personality: "bare-llm", primaryModel: null });

      const exportedText = JSON.stringify(data);
      for (const id of [other.userId, other.tag, other.project.id, other.contract.id, other.unnoted.id, other.thread.id, other.chatFile.id]) {
        expect(exportedText).not.toContain(id);
      }
      // Leases, admissions and the login mapping are never read.
      expect(exportedText).not.toContain(owner.principal);
      expect(exportedText).not.toContain(owner.userId);
      expect(exportedText).not.toContain("private replay");

      // The archive built from it holds every original file byte-for-byte, and no storage keys.
      const entries = await unzip(createAccountExport({ userId: owner.userId, data, exportedAt: new Date() }));
      const root = "signloop-export";
      const contractsJson = json(entries, `${root}/contracts.json`) as Array<{
        id: string;
        files: Array<{ path: string }>;
        notes: Record<string, unknown> | null;
      }>;
      expect(contractsJson.map((row) => [row.id, row.notes])).toEqual([
        [owner.contract.id, { ...owner.notes, createdAt: expect.any(String), updatedAt: expect.any(String) }],
        [owner.unnoted.id, null],
      ]);
      expect(contractsJson[0]!.files.map((file) => file.path)).toEqual([
        `files/contracts/${owner.contract.id}/lease.txt`,
        `files/contracts/${owner.contract.id}/lease (2).txt`,
      ]);
      expect(entries.get(`${root}/files/contracts/${owner.contract.id}/lease.txt`)).toEqual(owner.uploads[0]);
      expect(entries.get(`${root}/files/contracts/${owner.contract.id}/lease (2).txt`)).toEqual(owner.uploads[1]);
      expect(entries.get(`${root}/files/projects/${owner.project.id}/_brief.txt`)).toEqual(owner.contextBytes);
      expect(entries.get(`${root}/files/chats/${owner.thread.id}/notes.txt`)).toEqual(owner.chatBytes);
      expect(entries.get(`${root}/files/chats/${owner.thread.id}/${data.chatImages[0]!.id}.png`)).toEqual(png);
      const archiveText = [...entries.values()].map((entry) => entry.toString("latin1")).join("\n");
      expect(archiveText).not.toContain("export-file-");
      expect(archiveText).not.toContain("export-context-");
      expect(archiveText).not.toContain(other.userId);
      expect(archiveText).not.toContain(other.tag);
      expect(entries.get(`${root}/README.txt`)!.toString()).not.toContain("could not be found");

      // An account with nothing in it exports empty collections.
      const empty = await getAccountExportForUser(await resolveWorkOSUserId({ id: `user_${crypto.randomUUID()}` }));
      expect(empty).toEqual({
        contracts: [], contractFiles: [], contractNotes: [], analyses: [], projects: [], contextDocuments: [],
        chatThreads: [], chatMessages: [], chatFiles: [], chatImages: [], settings: null,
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(storageRoot, { recursive: true, force: true });
    }
  });
});
