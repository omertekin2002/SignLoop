import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountExportData } from "@/lib/server-db";
import { json, unzip } from "@/lib/test-unzip";

const { auth, getAccountExportForUser, getChatFileForUser, getChatImageForUser, readObject } = vi.hoisted(() => ({
  auth: vi.fn(),
  getAccountExportForUser: vi.fn(),
  getChatFileForUser: vi.fn(),
  getChatImageForUser: vi.fn(),
  readObject: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({ getAccountExportForUser, getChatFileForUser, getChatImageForUser }));
vi.mock("@/lib/object-storage", () => ({ readObject }));

import { GET } from "@/app/api/account/export/route";

const request = () => new Request("http://localhost/api/account/export");
const at = "2026-10-01T09:00:00.000Z";

const empty: AccountExportData = {
  contracts: [],
  contractFiles: [],
  contractNotes: [],
  analyses: [],
  projects: [],
  contextDocuments: [],
  chatThreads: [],
  chatMessages: [],
  chatFiles: [],
  chatImages: [],
  settings: null,
};

const contractPdf = Uint8Array.from({ length: 50_000 }, (_, index) => (index * 7) % 256);
const contextDocx = Uint8Array.of(80, 75, 3, 4, 9, 9);
const chatText = Buffer.from("Chat notes");
const chatPng = Buffer.from([137, 80, 78, 71, 1, 2, 3]);

const stored = new Map<string, Uint8Array<ArrayBuffer>>([
  ["https://store.private.blob.vercel-storage.com/contracts/c1/lease.pdf", contractPdf],
  ["https://store.private.blob.vercel-storage.com/contracts/c1/lease-2.pdf", Uint8Array.of(1)],
  ["context/p1/brief.docx", contextDocx],
]);

const workspace: AccountExportData = {
  contracts: [
    { id: "c1", projectId: "p1", title: "Lease", status: "ANALYZED", textContent: "Clause 1.", extractionWarning: null, confirmedJurisdiction: "Ontario", jurisdictionConfirmedAt: at, createdAt: at, updatedAt: at },
  ],
  contractFiles: [
    { id: "f1", contractId: "c1", fileName: "lease.pdf", contentType: "application/pdf", sizeBytes: contractPdf.length, extractionMethod: "pdf_text", extractionConfidence: null, createdAt: at, storageKey: "https://store.private.blob.vercel-storage.com/contracts/c1/lease.pdf" },
    { id: "f2", contractId: "c1", fileName: "../lease.pdf", contentType: "application/pdf", sizeBytes: 1, extractionMethod: null, extractionConfidence: null, createdAt: at, storageKey: "https://store.private.blob.vercel-storage.com/contracts/c1/lease-2.pdf" },
    { id: "f3", contractId: null, fileName: "old.pdf", contentType: null, sizeBytes: null, extractionMethod: null, extractionConfidence: null, createdAt: at, storageKey: "legacy/old.pdf" },
  ],
  contractNotes: [
    { contractId: "c1", acceptanceReasons: "Rent is fixed for two years.", openQuestions: "Who repairs the boiler?", createdAt: at, updatedAt: at },
  ],
  analyses: [
    { id: "a1", contractId: "c1", riskBadge: "LOW", resultJson: { summary: "Fine" }, llmProvider: "openrouter", llmModel: "model", llmPromptTokens: 10, llmCompletionTokens: 5, processingTimeMs: 100, createdAt: at },
  ],
  projects: [{ id: "p1", title: "Office", description: null, status: "active", createdAt: at, updatedAt: at }],
  contextDocuments: [
    { id: "d1", projectId: "p1", title: "Brief", documentType: "other", originalFilename: "brief.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: contextDocx.length, wordCount: 1, extractedText: "Brief", extractionWarning: null, createdAt: at, updatedAt: at, storageKey: "context/p1/brief.docx" },
  ],
  chatThreads: [{ id: "t1", title: "Questions", createdAt: at, updatedAt: at }],
  chatMessages: [
    { id: "m1", threadId: "t1", role: "user", content: "Hi", position: 0, createdAt: at, model: null, provider: null },
    { id: "m2", threadId: "t1", role: "assistant", content: "![Generated image](/api/chat/threads/t1/images/i1)", position: 1, createdAt: at, model: "model", provider: "openrouter" },
  ],
  chatFiles: [{ id: "cf1", threadId: "t1", filename: "notes.txt", mediaType: "text/plain", sizeBytes: chatText.length, warning: null, createdAt: at }],
  chatImages: [{ id: "i1", threadId: "t1", sizeBytes: chatPng.length, createdAt: at }],
  settings: { primaryModel: null, personality: "bare-llm", updatedAt: at },
};

function signedIn(data: AccountExportData) {
  auth.mockResolvedValue({ userId: "owner" });
  getAccountExportForUser.mockResolvedValue(data);
  readObject.mockImplementation(async (key: string) =>
    stored.has(key) ? new Response(stored.get(key)).body : null,
  );
  getChatFileForUser.mockImplementation(async (userId: string, threadId: string, fileId: string) =>
    userId === "owner" && threadId === "t1" && fileId === "cf1"
      ? { name: "notes.txt", mediaType: "text/plain", data: chatText }
      : null,
  );
  getChatImageForUser.mockImplementation(async (userId: string, threadId: string, imageId: string) =>
    userId === "owner" && threadId === "t1" && imageId === "i1" ? chatPng : null,
  );
}

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("GET /api/account/export", () => {
  it("returns JSON 401 without a session and reads nothing", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getAccountExportForUser).not.toHaveBeenCalled();
  });

  it("returns a private ZIP download named for the export date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T23:30:00Z"));
    signedIn(empty);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="signloop-export-2026-10-26.zip"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getAccountExportForUser).toHaveBeenCalledExactlyOnceWith("owner");
    const entries = await unzip(response);
    expect(entries.get("signloop-export/README.txt")!.toString()).toContain("Exported: 2026-10-26T23:30:00.000Z");
  });

  it("exports an empty workspace as empty JSON arrays", async () => {
    signedIn(empty);

    const entries = await unzip(await GET(request()));

    expect([...entries.keys()].sort()).toEqual([
      "signloop-export/README.txt",
      "signloop-export/analyses.json",
      "signloop-export/chats.json",
      "signloop-export/contracts.json",
      "signloop-export/projects.json",
      "signloop-export/settings.json",
    ]);
    for (const name of ["analyses", "chats", "contracts", "projects"]) {
      expect(json(entries, `signloop-export/${name}.json`)).toEqual([]);
    }
    expect(json(entries, "signloop-export/settings.json")).toBeNull();
  });

  it("writes the owner's records and every stored file byte-identically", async () => {
    signedIn(workspace);

    const entries = await unzip(await GET(request()));
    const root = "signloop-export";

    expect(json(entries, `${root}/contracts.json`)).toEqual([
      {
        id: "c1", projectId: "p1", title: "Lease", status: "ANALYZED", text: "Clause 1.", extractionWarning: null, confirmedJurisdiction: "Ontario", jurisdictionConfirmedAt: at, createdAt: at, updatedAt: at,
        files: [
          { id: "f1", fileName: "lease.pdf", contentType: "application/pdf", sizeBytes: contractPdf.length, extractionMethod: "pdf_text", extractionConfidence: null, uploadedAt: at, path: "files/contracts/c1/lease.pdf" },
          { id: "f2", fileName: "../lease.pdf", contentType: "application/pdf", sizeBytes: 1, extractionMethod: null, extractionConfidence: null, uploadedAt: at, path: "files/contracts/c1/_lease.pdf" },
        ],
        notes: { acceptanceReasons: "Rent is fixed for two years.", openQuestions: "Who repairs the boiler?", createdAt: at, updatedAt: at },
      },
    ]);
    expect(json(entries, `${root}/analyses.json`)).toEqual(workspace.analyses);
    expect(json(entries, `${root}/projects.json`)).toEqual([
      {
        id: "p1", title: "Office", description: null, status: "active", createdAt: at, updatedAt: at,
        contextDocuments: [
          { id: "d1", title: "Brief", documentType: "other", originalFilename: "brief.docx", contentType: workspace.contextDocuments[0]!.contentType, sizeBytes: contextDocx.length, wordCount: 1, extractedText: "Brief", extractionWarning: null, createdAt: at, updatedAt: at, path: "files/projects/p1/brief.docx" },
        ],
      },
    ]);
    expect(json(entries, `${root}/chats.json`)).toEqual([
      {
        id: "t1", title: "Questions", createdAt: at, updatedAt: at,
        messages: [
          { id: "m1", role: "user", content: "Hi", position: 0, createdAt: at, model: null, provider: null },
          { id: "m2", role: "assistant", content: "![Generated image](/api/chat/threads/t1/images/i1)", position: 1, createdAt: at, model: "model", provider: "openrouter" },
        ],
        files: [{ id: "cf1", filename: "notes.txt", mediaType: "text/plain", sizeBytes: chatText.length, warning: null, createdAt: at, path: "files/chats/t1/notes.txt" }],
        images: [{ id: "i1", sizeBytes: chatPng.length, createdAt: at, path: "files/chats/t1/i1.png" }],
      },
    ]);
    expect(json(entries, `${root}/settings.json`)).toEqual({ primaryModel: null, personality: "bare-llm", updatedAt: at });

    expect(entries.get(`${root}/files/contracts/c1/lease.pdf`)!.equals(Buffer.from(contractPdf))).toBe(true);
    expect([...entries.get(`${root}/files/contracts/c1/_lease.pdf`)!]).toEqual([1]);
    expect(entries.get(`${root}/files/projects/p1/brief.docx`)!.equals(Buffer.from(contextDocx))).toBe(true);
    expect(entries.get(`${root}/files/chats/t1/notes.txt`)!.equals(chatText)).toBe(true);
    expect(entries.get(`${root}/files/chats/t1/i1.png`)!.equals(chatPng)).toBe(true);

    // The legacy file without a contract was gone from storage: listed, not invented.
    const readme = entries.get(`${root}/README.txt`)!.toString();
    expect(readme).toContain("These files were deleted or could not be found");
    expect(readme).toContain("  files/contracts/unlinked/old.pdf");
    expect(entries.has(`${root}/files/contracts/unlinked/old.pdf`)).toBe(false);

    // Chat bytes are read through the owner-scoped lookups.
    expect(getChatFileForUser).toHaveBeenCalledWith("owner", "t1", "cf1");
    expect(getChatImageForUser).toHaveBeenCalledWith("owner", "t1", "i1");
    expect(readObject).toHaveBeenCalledWith("context/p1/brief.docx", expect.any(AbortSignal));

    // Internal storage locations and the owner ID never reach the archive.
    const text = [...entries.values()].map((entry) => entry.toString("latin1")).join("\n");
    expect(text).not.toContain("storageKey");
    expect(text).not.toContain("blob.vercel-storage.com");
    expect(text).not.toContain("context/p1/brief.docx");
    expect(text).not.toContain('"owner"');
    expect(text).not.toContain("userId");
  });

  it("returns JSON 500 when the export cannot be read", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getAccountExportForUser.mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to export your data" });
    vi.restoreAllMocks();
  });
});
