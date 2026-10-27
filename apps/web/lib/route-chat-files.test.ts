import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  isChatThreadOwnedByUser,
  saveChatFileForUser,
  getChatFileForUser,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  isChatThreadOwnedByUser: vi.fn(),
  saveChatFileForUser: vi.fn(),
  getChatFileForUser: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  isChatThreadOwnedByUser,
  saveChatFileForUser,
  getChatFileForUser,
}));
import { POST } from "@/app/api/chat/files/route";
import { POST as parse } from "@/app/api/internal/parse/route";
import { GET } from "@/app/api/chat/threads/[id]/files/[fileId]/route";
import { generateChatFile } from "./chat-file-generation";
import { savedChatFile } from "./chat-files-shared";

const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const fileId = "7b0d5c1e-2a43-4f6b-9a1c-3d8e5f6a7b8c";
function request(
  file = new File(["Payment is due in thirty days."], "terms.txt", {
    type: "text/plain",
  }),
  saved = false,
) {
  const form = new FormData();
  form.set("file", file);
  return new Request(
    `http://localhost/api/chat/files${saved ? `?threadId=${threadId}` : ""}`,
    { method: "POST", body: form },
  );
}
// The parse call reaches the parse-only function's real handler in-process, as `next start` would.
const parseCall = vi.fn((url: string | URL, init?: RequestInit) =>
  parse(new Request(url, init)),
);
beforeEach(() => {
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "a-test-cookie-password-of-32-chars!!");
  vi.stubEnv("VERCEL_URL", "");
  vi.stubGlobal("fetch", parseCall);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("chat file upload", () => {
  it("requires authentication before extraction or storage", async () => {
    auth.mockResolvedValue({ userId: null });
    expect((await POST(request())).status).toBe(401);
    expect(saveChatFileForUser).not.toHaveBeenCalled();
    expect(parseCall).not.toHaveBeenCalled();
  });
  it("rejects a foreign thread before reading the upload", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    isChatThreadOwnedByUser.mockResolvedValue(false);
    expect((await POST(request(undefined, true))).status).toBe(404);
    expect(saveChatFileForUser).not.toHaveBeenCalled();
    expect(parseCall).not.toHaveBeenCalled();
  });
  it("extracts temporary text without storing the file", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).file).toMatchObject({
      name: "terms.txt",
      text: "Payment is due in thirty days.",
      mediaType: "text/plain",
    });
    expect(saveChatFileForUser).not.toHaveBeenCalled();
    expect(String(parseCall.mock.calls[0]![0])).toBe(
      "http://localhost/api/internal/parse",
    );
  });
  it.each(["pdf", "docx"] as const)(
    "accepts a real %s and saves the original bytes under the owner",
    async (format) => {
      auth.mockResolvedValue({ userId: "owner" });
      isChatThreadOwnedByUser.mockResolvedValue(true);
      saveChatFileForUser.mockImplementation(async ({ file }) =>
        savedChatFile(file, threadId),
      );
      const document = await generateChatFile({
        name: "terms",
        format,
        content:
          "Payment is due in thirty days. All obligations remain in effect until written notice is received.",
      });
      const bytes = Buffer.from(document.data, "base64");
      const response = await POST(
        request(
          new File([bytes], document.name, { type: document.mediaType }),
          true,
        ),
      );
      expect(response.status).toBe(200);
      const result = (await response.json()).file;
      expect(result.url).toContain(`/api/chat/threads/${threadId}/files/`);
      expect(result).not.toHaveProperty("text");
      expect(saveChatFileForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "owner",
          threadId,
          data: bytes,
          file: expect.objectContaining({
            text: expect.stringContaining("Payment is due in thirty days."),
          }),
        }),
      );
    },
  );
  it.each([
    new File(["not PDF"], "fake.pdf", { type: "application/pdf" }),
    new File(["bad"], "script.html", { type: "text/html" }),
    new File([new Uint8Array(4 * 1024 * 1024 + 1)], "large.txt", {
      type: "text/plain",
    }),
    new File(["x".repeat(200_001)], "long.txt", { type: "text/plain" }),
  ])("rejects invalid or oversized content ($name)", async (file) => {
    auth.mockResolvedValue({ userId: "owner" });
    expect((await POST(request(file))).status).toBeGreaterThanOrEqual(400);
    expect(saveChatFileForUser).not.toHaveBeenCalled();
  });
});

describe("chat file extraction in the parse function", () => {
  it("keeps the no-readable-text message for a file without text", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    const response = await POST(
      request(new File([" \n\t "], "blank.txt", { type: "text/plain" })),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "No readable text was found. For scanned PDFs, attach a version with a text layer.",
    });
    expect(parseCall).toHaveBeenCalledOnce();
  });
  it("answers 503 without saving when the parse function is unreachable", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isChatThreadOwnedByUser.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseCall.mockRejectedValueOnce(new TypeError("fetch failed"));
    const response = await POST(request(undefined, true));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Text extraction is unavailable right now. Please try again shortly.",
    });
    expect(saveChatFileForUser).not.toHaveBeenCalled();
  });
});

describe("private chat downloads", () => {
  const call = () =>
    GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: threadId, fileId }),
    });
  it("returns bytes with a safe Unicode download name and private headers", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatFileForUser.mockResolvedValue({
      name: "İstanbul notes.txt",
      mediaType: "text/plain",
      data: Buffer.from("Private notes"),
    });
    const response = await call();
    expect(await response.text()).toBe("Private notes");
    expect(response.headers.get("Content-Disposition")).toContain(
      "filename*=UTF-8''%C4%B0stanbul%20notes.txt",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getChatFileForUser).toHaveBeenCalledWith("owner", threadId, fileId);
  });
  it("returns 404 for a missing/foreign file and requires auth", async () => {
    auth.mockResolvedValue({ userId: "other" });
    getChatFileForUser.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    auth.mockResolvedValue({ userId: null });
    expect((await call()).status).toBe(401);
  });
});
