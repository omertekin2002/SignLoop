import { afterEach, describe, expect, it, vi } from "vitest";

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
afterEach(() => vi.resetAllMocks());

describe("chat file upload", () => {
  it("requires authentication before extraction or storage", async () => {
    auth.mockResolvedValue({ userId: null });
    expect((await POST(request())).status).toBe(401);
    expect(saveChatFileForUser).not.toHaveBeenCalled();
  });
  it("rejects a foreign thread before reading the upload", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    isChatThreadOwnedByUser.mockResolvedValue(false);
    expect((await POST(request(undefined, true))).status).toBe(404);
    expect(saveChatFileForUser).not.toHaveBeenCalled();
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
