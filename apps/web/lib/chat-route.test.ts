import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  claimGenerationOperation,
  admitChat,
  appendChatMessagesToThread,
  getChatTurnByTurnId,
  getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId,
  getChatDocumentsForUser,
  getModelAvailabilitySnapshot,
  generateChatTitle,
  generateChatReply,
  generateChatReplyStream,
  hasImageInputProvider,
  after,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  claimGenerationOperation: vi.fn(),
  admitChat: vi.fn(),
  appendChatMessagesToThread: vi.fn(),
  getChatTurnByTurnId: vi.fn(),
  getRecentChatMessagesForThreadForUser: vi.fn(),
  getUserSettingsByUserId: vi.fn(),
  getChatDocumentsForUser: vi.fn(),
  getModelAvailabilitySnapshot: vi.fn(),
  generateChatTitle: vi.fn(),
  generateChatReply: vi.fn(),
  generateChatReplyStream: vi.fn(),
  hasImageInputProvider: vi.fn(),
  after: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  claimGenerationOperation,
  appendChatMessagesToThread,
  getChatTurnByTurnId,
  getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId,
  getChatDocumentsForUser,
  // No thread in these tests is about a contract (see chat-route-focus.test.ts).
  getChatThreadFocusForUser: vi.fn().mockResolvedValue(null),
  getChatFocusContractForUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/chat-title", () => ({ generateChatTitle }));
vi.mock("@/lib/chat", () => ({ generateChatReply, generateChatReplyStream, hasImageInputProvider }));
vi.mock("@/lib/model-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-settings")>()),
  getModelAvailabilitySnapshot,
}));
vi.mock("@/lib/chat-admission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-admission")>()),
  admitChat,
}));
vi.mock("@/lib/telemetry", () => ({
  isTelemetryEnabled: false,
  flushTelemetry: vi.fn(),
}));

import { POST } from "@/app/api/chat/route";
import { chatImage } from "./fixtures/chat-image";
import { savedChatFile } from "./chat-files-shared";
import { validateContractReplay } from "@/lib/contract-evidence";
import {
  MAX_CHAT_REQUEST_BODY_BYTES,
  MAX_CHAT_DOCUMENT_REQUEST_BODY_BYTES,
} from "./chat-history-bounds";

const resetAt = "2026-10-19T15:00:00.000Z";

/** Run the work the route deferred with after(), as the runtime does once the response ends. */
async function runAfterTasks() {
  await Promise.all(
    after.mock.calls.map(([task]) => (typeof task === "function" ? task() : task)),
  );
}
const quota = (used: number) => ({
  limit: 30,
  used,
  remaining: 30 - used,
  resetAt,
  concurrency: { limit: 2, inUse: 1 },
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("authenticated chat body limits", () => {
  it("rejects an impossible declared size before authentication or body reads", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "Content-Length": String(MAX_CHAT_DOCUMENT_REQUEST_BODY_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
    expect(auth).not.toHaveBeenCalled();
    expect(admitChat).not.toHaveBeenCalled();
  });

  it("rejects an anonymous declared size above 128 KiB without reading its body", async () => {
    auth.mockResolvedValue({ userId: null });
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Length": String(MAX_CHAT_REQUEST_BODY_BYTES + 1) },
      body,
      duplex: "half",
    } as RequestInit);
    expect((await POST(req)).status).toBe(413);
    expect(auth).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    expect(admitChat).not.toHaveBeenCalled();
  });

  it("waits for authentication and caps an anonymous chunked body at 128 KiB", async () => {
    let authenticate!: (value: { userId: null }) => void;
    auth.mockReturnValue(
      new Promise((resolve) => {
        authenticate = resolve;
      }),
    );
    const cancel = vi.fn();
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array(MAX_CHAT_REQUEST_BODY_BYTES + 1));
      },
    );
    const body = new ReadableStream<Uint8Array>(
      { pull, cancel },
      { highWaterMark: 0 },
    );
    const pending = POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    );
    await Promise.resolve();
    expect(auth).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    authenticate({ userId: null });
    expect((await pending).status).toBe(413);
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(admitChat).not.toHaveBeenCalled();
    expect(generateChatReply).not.toHaveBeenCalled();
    expect(generateChatReplyStream).not.toHaveBeenCalled();
  });
});

describe("saved chat admission", () => {
  it("does not charge admission for a busy thread", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    claimGenerationOperation.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "11e3e947-f71f-4ecd-a901-adbf24edbb8a",
          messages: [{ role: "user", content: "What does this mean?" }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(claimGenerationOperation).toHaveBeenCalledOnce();
    expect(admitChat).not.toHaveBeenCalled();
  });

  const savedRequest = () =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "11e3e947-f71f-4ecd-a901-adbf24edbb8a",
        messages: [{ role: "user", content: "What does this mean?" }],
      }),
    });

  it("checks the thread before admission, so a missing or foreign thread costs no quota", async () => {
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    auth.mockResolvedValue({ userId: "owner" });
    claimGenerationOperation.mockResolvedValue(releaseLease);
    getRecentChatMessagesForThreadForUser.mockResolvedValue(null);

    const response = await POST(savedRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Chat thread not found" });
    expect(getRecentChatMessagesForThreadForUser).toHaveBeenCalledWith(
      "owner",
      "11e3e947-f71f-4ecd-a901-adbf24edbb8a",
      expect.any(Number),
    );
    expect(admitChat).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(response.headers.get("RateLimit")).toBeNull();
    expect(generateChatReply).not.toHaveBeenCalled();
    expect(generateChatReplyStream).not.toHaveBeenCalled();
  });

  // The Retry-After values are deliberately mismatched with the reasons: wording follows the reason.
  it.each([
    [
      "busy",
      3_600,
      "Chat is busy with other replies. Please try again shortly.",
    ],
    [
      "hourly",
      30,
      "Chat is at its hourly request limit. Please try again later.",
    ],
    [
      "daily",
      30,
      "Chat is at its daily request limit. Please try again later.",
    ],
  ] as const)(
    "maps a %s rejection to 429 by its reason (Retry-After %i)",
    async (reason, retryAfter, error) => {
      const releaseLease = vi.fn().mockResolvedValue(undefined);
      auth.mockResolvedValue({ userId: "owner" });
      claimGenerationOperation.mockResolvedValue(releaseLease);
      getRecentChatMessagesForThreadForUser.mockResolvedValue([]);
      admitChat.mockResolvedValue({
        retryAfter,
        reason,
        resetAt,
        quota: quota(30),
      });

      const response = await POST(savedRequest());

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(String(retryAfter));
      expect(response.headers.get("RateLimit-Policy")).toBe(
        '"account";q=30;w=3600',
      );
      expect(response.headers.get("RateLimit")).toMatch(
        /^"account";r=0;t=\d+$/,
      );
      expect(await response.json()).toEqual({
        error,
        reason,
        resetAt,
        quota: quota(30),
      });
      expect(admitChat).toHaveBeenCalledExactlyOnceWith("owner");
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(generateChatReply).not.toHaveBeenCalled();
      expect(generateChatReplyStream).not.toHaveBeenCalled();
      expect(appendChatMessagesToThread).not.toHaveBeenCalled();
    },
  );

  it("rejects anonymous temporary chat without describing the shared bucket", async () => {
    auth.mockResolvedValue({ userId: null });
    admitChat.mockResolvedValue({
      retryAfter: 1_204,
      reason: "hourly",
      resetAt,
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temporary: true,
          messages: [{ role: "user", content: "What does this mean?" }],
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1204");
    expect(response.headers.get("RateLimit")).toBeNull();
    expect(response.headers.get("RateLimit-Policy")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Chat is at its hourly request limit. Please try again later.",
      reason: "hourly",
      resetAt,
    });
    expect(admitChat).toHaveBeenCalledExactlyOnceWith(null);
    expect(claimGenerationOperation).not.toHaveBeenCalled();
    expect(getRecentChatMessagesForThreadForUser).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when admission cannot be checked", async () => {
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    auth.mockResolvedValue({ userId: "owner" });
    claimGenerationOperation.mockResolvedValue(releaseLease);
    getRecentChatMessagesForThreadForUser.mockResolvedValue([]);
    admitChat.mockRejectedValue(new Error("db down"));

    const response = await POST(savedRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Chat is temporarily unavailable. Please try again shortly.",
    });
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(generateChatReply).not.toHaveBeenCalled();
    expect(generateChatReplyStream).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });
});

describe.each([false, true])("automatic chat titles (stream=%s)", (stream) => {
  const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
  const reply = {
    message: "Renewal extends the term.",
    model: "selected-model",
    provider: "primary-openai-compatible",
    webSearch: null,
  };
  const request = (extra: Record<string, unknown> = {}) =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        stream,
        messages: [{ role: "user", content: "Explain my lease renewal." }],
        ...extra,
      }),
    });
  async function completion(response: Response) {
    if (!stream) return response.json();
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toEqual({ type: "delta", text: reply.message });
    return events.at(-1);
  }

  beforeEach(() => {
    auth.mockResolvedValue({ userId: "owner" });
    claimGenerationOperation.mockResolvedValue(
      vi.fn().mockResolvedValue(undefined),
    );
    admitChat.mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
    });
    getUserSettingsByUserId.mockResolvedValue({
      primaryModel: "selected-model",
    });
    getModelAvailabilitySnapshot.mockResolvedValue({
      availablePrimaryModels: ["other-model", "selected-model"],
      availableImageInputModels: ["selected-model"],
      imageGenerationAvailable: false,
    });
    hasImageInputProvider.mockReturnValue(true);
    getRecentChatMessagesForThreadForUser.mockResolvedValue([]);
    generateChatTitle.mockResolvedValue("Lease Renewal Terms");
    generateChatReply.mockResolvedValue(reply);
    generateChatReplyStream.mockImplementation(async function* () {
      yield { type: "delta", text: reply.message };
      yield { type: "done", reply };
    });
    appendChatMessagesToThread.mockResolvedValue([]);
  });

  it("accepts an authenticated temporary document body above the anonymous limit", async () => {
    const document = {
      id: "abcdef01-2345-4678-9abc-def012345678",
      name: "large.txt",
      mediaType: "text/plain",
      size: 140_000,
      text: "x".repeat(140_000),
    };
    const input = request({
      temporary: true,
      messages: [
        { role: "user", content: "Read this document", documents: [document] },
      ],
    });
    expect(Buffer.byteLength(await input.clone().text())).toBeGreaterThan(
      MAX_CHAT_REQUEST_BODY_BYTES,
    );
    const result = await completion(await POST(input));
    expect(result.message).toBe(reply.message);
    expect(
      stream ? generateChatReplyStream : generateChatReply,
    ).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ documents: [document] }),
    );
  });

  it("loads saved document contents from the owner-scoped database and persists only file descriptors", async () => {
    const file = { id: "abcdef01-2345-4678-9abc-def012345678", name: "terms.txt", mediaType: "text/plain", size: 12, text: "Private terms" };
    getChatDocumentsForUser.mockResolvedValue([file]);
    const result = await completion(await POST(request({ messages: [{ role: "user", content: "Read my terms", fileIds: [file.id], documents: [{ ...file, text: "fabricated" }] }] })));
    expect(result.persisted).toBe(true);
    expect(stream ? generateChatReplyStream : generateChatReply).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ role: "user", fileIds: [file.id] })]),
      expect.objectContaining({ documents: [file], enableDocuments: true }),
    );
    const written = appendChatMessagesToThread.mock.calls[0]![0];
    expect(written.messages[0].metadata.files[0]).toMatchObject({ id: file.id, url: expect.stringContaining(`/threads/${threadId}/files/`) });
    expect(JSON.stringify(written)).not.toContain("fabricated");
    expect(JSON.stringify(written)).not.toContain("Private terms");
  });

  it("loads saved images from the owner-scoped database rather than client bytes", async () => {
    getChatDocumentsForUser.mockResolvedValue([chatImage]);
    const result = await completion(await POST(request({ messages: [{ role: "user", content: "What is in this image?", fileIds: [chatImage.id], images: [{ ...chatImage, data: "fabricated" }] }] })));
    expect(result.persisted).toBe(true);
    expect(stream ? generateChatReplyStream : generateChatReply).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ role: "user", images: [chatImage] })]),
      expect.objectContaining({ documents: [] }),
    );
    expect(appendChatMessagesToThread.mock.calls[0]![0].messages[0].metadata.files).toEqual([savedChatFile(chatImage, threadId)]);
    expect(JSON.stringify(appendChatMessagesToThread.mock.calls)).not.toContain(chatImage.data);
  });

  it("rejects an image turn before generation when no vision candidate is configured", async () => {
    hasImageInputProvider.mockReturnValue(false);
    const response = await POST(request({ temporary: true, messages: [{ role: "user", content: "Describe", images: [chatImage] }] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("vision-capable model");
    expect(generateChatReply).not.toHaveBeenCalled();
    expect(generateChatReplyStream).not.toHaveBeenCalled();
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });

  it("sends temporary images to the model without writing history", async () => {
    await completion(await POST(request({ temporary: true, messages: [{ role: "user", content: "Describe this image", images: [chatImage] }] })));
    expect(stream ? generateChatReplyStream : generateChatReply).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ role: "user", images: [chatImage] })]),
      expect.objectContaining({ documents: [] }),
    );
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });

  it("requires authentication for image attachments before admission", async () => {
    auth.mockResolvedValue({ userId: null });
    const response = await POST(request({ temporary: true, messages: [{ role: "user", content: "Describe", images: [chatImage] }] }));
    expect(response.status).toBe(401);
    expect(admitChat).not.toHaveBeenCalled();
  });

  it("reloads recent images for a saved follow-up", async () => {
    getRecentChatMessagesForThreadForUser.mockResolvedValue([
      { role: "user", content: "Describe this", files: [savedChatFile(chatImage, threadId)] },
      { role: "assistant", content: "A screenshot." },
    ]);
    getChatDocumentsForUser.mockResolvedValue([chatImage]);
    await completion(await POST(request()));
    expect(getChatDocumentsForUser).toHaveBeenCalledWith("owner", threadId, [chatImage.id]);
    expect(stream ? generateChatReplyStream : generateChatReply).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: "Describe this", images: [chatImage] })]), expect.any(Object),
    );
  });

  it("loads only four newest saved images, and attaches a reused image only once", async () => {
    const uploads = Array.from({ length: 6 }, (_, index) => ({ ...chatImage, id: `abcdef01-2345-4678-9abc-def01234567${index}` }));
    getRecentChatMessagesForThreadForUser.mockResolvedValue([
      ...uploads.map((image) => ({ role: "user", content: "Describe", files: [savedChatFile(image, threadId)] })),
      { role: "user", content: "Reused image", files: [savedChatFile(uploads[5]!, threadId)] },
    ]);
    getChatDocumentsForUser.mockResolvedValue(uploads.slice(-4));
    await completion(await POST(request()));
    expect(getChatDocumentsForUser.mock.calls[0]![2]).toEqual(expect.arrayContaining(uploads.slice(-4).map((image) => image.id)));
    expect(getChatDocumentsForUser.mock.calls[0]![2]).not.toContain(uploads[0]!.id);
    const messages = (stream ? generateChatReplyStream : generateChatReply).mock.calls[0]![0];
    expect(messages.flatMap((message: { images?: unknown[] }) => message.images ?? [])).toHaveLength(4);
    expect(messages.find((message: { content: string }) => message.content === "Reused image").images).toEqual([uploads[5]]);
  });

  it("rejects a foreign attachment without charging quota", async () => {
    getChatDocumentsForUser.mockResolvedValue([]);
    const response = await POST(request({ messages: [{ role: "user", content: "Read my terms", fileIds: ["abcdef01-2345-4678-9abc-def012345678"] }] }));
    expect(response.status).toBe(400);
    expect(admitChat).not.toHaveBeenCalled();
  });

  it.each([true, false])("returns generated file downloads even when saved persistence is %s", async (persisted) => {
    const file = { id: "abcdef01-2345-4678-9abc-def012345678", name: "notes.txt", mediaType: "text/plain", size: 5, text: "Hello", data: "SGVsbG8=" };
    const withFile = { ...reply, files: [file] };
    generateChatReply.mockResolvedValue(withFile);
    generateChatReplyStream.mockImplementation(async function* () { yield { type: "delta", text: reply.message }; yield { type: "done", reply: withFile }; });
    const saved = { id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, url: `/api/chat/threads/${threadId}/files/${file.id}` };
    if (persisted) appendChatMessagesToThread.mockResolvedValue([{ role: "assistant", content: reply.message, files: [saved] }]);
    else appendChatMessagesToThread.mockRejectedValue(new Error("Database unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await completion(await POST(request()));
    expect(result.persisted).toBe(persisted);
    expect(result.files).toEqual(persisted ? [saved] : [{ id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, data: file.data }]);
    expect(appendChatMessagesToThread.mock.calls[0]![0].generatedFiles).toEqual([file]);
    log.mockRestore();
  });

  it("keeps editable generated text in temporary browser state without storing bytes in replay", async () => {
    const file = { id: "abcdef01-2345-4678-9abc-def012345678", name: "notes.txt", mediaType: "text/plain", size: 5, text: "Hello", data: "SGVsbG8=" };
    const withFile = { ...reply, files: [file] };
    generateChatReply.mockResolvedValue(withFile);
    generateChatReplyStream.mockImplementation(async function* () { yield { type: "delta", text: reply.message }; yield { type: "done", reply: withFile }; });
    const result = await completion(await POST(request({ temporary: true })));
    expect(result.documents).toEqual([{ id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, text: "Hello" }]);
    expect(result.documents[0]).not.toHaveProperty("data");
    expect(result.files[0].data).toBe(file.data);
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });

  it("names the first saved turn using the same resolved model as the reply", async () => {
    const result = await completion(await POST(request()));
    expect(result.message).toBe(reply.message);
    expect(result.persisted).toBe(true);
    expect(generateChatTitle).toHaveBeenCalledExactlyOnceWith(
      "Explain my lease renewal.",
      {
        primaryModel: "selected-model",
        signal: expect.any(AbortSignal),
      },
    );
    expect(
      stream ? generateChatReplyStream : generateChatReply,
    ).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ primaryModel: "selected-model", recordTelemetry: true }),
    );
    expect(appendChatMessagesToThread).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner",
        threadId,
        generatedTitle: "Lease Renewal Terms",
      }),
    );
  });

  it("passes the resolved fallback selection to both generators when the saved model is unavailable", async () => {
    getModelAvailabilitySnapshot.mockResolvedValue({
      availablePrimaryModels: [],
      imageGenerationAvailable: false,
    });
    await completion(await POST(request()));
    expect(generateChatTitle).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ primaryModel: null }),
    );
    expect(
      stream ? generateChatReplyStream : generateChatReply,
    ).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ primaryModel: null }),
    );
  });

  it("still saves the reply when all title providers fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    generateChatTitle.mockRejectedValue(new Error("All providers failed"));
    const result = await completion(await POST(request()));
    expect(result.message).toBe(reply.message);
    expect(result.persisted).toBe(true);
    expect(appendChatMessagesToThread).toHaveBeenCalledWith(
      expect.objectContaining({ generatedTitle: null }),
    );
  });

  it("saves the finished reply when the real title generator reaches its independent deadline", async () => {
    const titles = await vi.importActual<typeof import("./chat-title")>("./chat-title");
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    generateChatTitle.mockImplementation(titles.generateChatTitle);
    let titleSignal: AbortSignal | undefined;
    generateChatReply.mockImplementation((_messages, options) => {
      if (options?.maxOutputTokens === titles.CHAT_TITLE_MAX_OUTPUT_TOKENS) {
        titleSignal = options.signal;
        return new Promise(() => {});
      }
      return Promise.resolve(reply);
    });
    const result = POST(request()).then(completion);
    await vi.waitFor(() => expect(titleSignal).toBeDefined());
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(titles.CHAT_TITLE_TIMEOUT_MS);
    expect((await result).persisted).toBe(true);
    expect(titleSignal?.aborted).toBe(true);
    expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ generatedTitle: null }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("usage reporting", () => {
    it("reports the account quota in RateLimit headers and the completion", async () => {
      admitChat.mockResolvedValue({
        release: vi.fn().mockResolvedValue(undefined),
        quota: quota(18),
      });

      const response = await POST(request());

      expect(response.headers.get("RateLimit-Policy")).toBe(
        '"account";q=30;w=3600',
      );
      expect(response.headers.get("RateLimit")).toMatch(
        /^"account";r=12;t=\d+$/,
      );
      expect((await completion(response)).quota).toEqual(quota(18));
    });

    it("describes no quota for anonymous temporary chat", async () => {
      auth.mockResolvedValue({ userId: null });

      const response = await POST(request({ temporary: true }));

      expect(admitChat).toHaveBeenCalledExactlyOnceWith(null);
      expect(response.headers.get("RateLimit")).toBeNull();
      expect(response.headers.get("RateLimit-Policy")).toBeNull();
      expect(await completion(response)).not.toHaveProperty("quota");
    });
  });

  it("does not generate a title for temporary chats", async () => {
    await completion(await POST(request({ temporary: true })));
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
    expect(stream ? generateChatReplyStream : generateChatReply).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ recordTelemetry: false }),
    );
  });

  it("does not rename an existing conversation", async () => {
    getRecentChatMessagesForThreadForUser.mockResolvedValue([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]);
    await completion(await POST(request()));
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).toHaveBeenCalledWith(
      expect.objectContaining({ generatedTitle: null }),
    );
  });

  it("never vouches for contract tools when the reply carries no receipt list", async () => {
    const withoutReceipts = {
      ...reply,
      toolActivity: [
        { id: "c1", tool: "list_contracts", query: "", status: "complete" },
      ],
    };
    generateChatReply.mockResolvedValue(withoutReceipts);
    generateChatReplyStream.mockImplementation(async function* () {
      yield { type: "delta", text: reply.message };
      yield { type: "done", reply: withoutReceipts };
    });
    await completion(await POST(request()));
    const metadata = (
      appendChatMessagesToThread.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; metadata?: Record<string, unknown> }>;
      }
    ).messages.find((message) => message.role === "assistant")!.metadata!;
    expect(metadata.contractEvidence).toBeUndefined();
    expect(
      validateContractReplay(metadata, new Map()).contractEvidenceInvalid,
    ).toBe(true);
  });

  it("never generates a title for another user's or missing thread", async () => {
    getRecentChatMessagesForThreadForUser.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });

  it("honors cancellation while the finished reply is waiting for its title", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    let started: () => void;
    const titleStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    generateChatTitle.mockImplementation(
      (_message, { signal }: { signal: AbortSignal }) => {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const response = POST(
      new Request(request(), { signal: controller.signal }),
    );
    await titleStarted;
    if (stream) {
      const reader = (await response).body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        reply.message,
      );
      controller.abort();
      expect((await reader.read()).done).toBe(true);
      await runAfterTasks();
      // The streamed reply never got its done event, so it is kept as an interrupted turn rather
      // than a finished one.
      expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({ role: "user", metadata: {} }),
            {
              role: "assistant",
              content: reply.message,
              metadata: { interrupted: true, interruptedReason: "stopped" },
            },
          ],
        }),
      );
    } else {
      expect(generateChatReply).toHaveBeenCalled();
      controller.abort();
      await response;
      expect(appendChatMessagesToThread).not.toHaveBeenCalled();
    }
  });

  it("cancels pending naming and does not save when the reply fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let titleSignal: AbortSignal | undefined;
    generateChatTitle.mockImplementation(
      (_message, { signal }: { signal: AbortSignal }) => {
        titleSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    generateChatReply.mockRejectedValue(new Error("Reply failed"));
    generateChatReplyStream.mockImplementation(async function* () {
      yield { type: "delta", text: "Partial reply" };
      throw new Error("Reply failed");
    });
    const response = await POST(request());
    const body = await response.text();
    expect(body).toContain("Chat request failed");
    expect(titleSignal?.aborted).toBe(true);
    await runAfterTasks();
    if (stream) {
      // The partial answer is kept, marked as cut off by an error, without the abandoned title.
      expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          generatedTitle: null,
          messages: [
            expect.objectContaining({ role: "user" }),
            {
              role: "assistant",
              content: "Partial reply",
              metadata: { interrupted: true, interruptedReason: "error" },
            },
          ],
        }),
      );
    } else {
      expect(appendChatMessagesToThread).not.toHaveBeenCalled();
    }
  });
});

describe.each([false, true])("saved chat turn retries (stream=%s)", (stream) => {
  const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
  const turnId = "6f1c2b9e-8d4a-4b7c-9e2f-0a1b2c3d4e5f";
  const reply = {
    message: "Renewal extends the term.",
    model: "selected-model",
    provider: "primary-openai-compatible",
    webSearch: null,
  };
  const download = {
    id: "abcdef01-2345-4678-9abc-def012345678",
    name: "summary.txt",
    mediaType: "text/plain",
    size: 7,
    url: `/api/chat/threads/${threadId}/files/abcdef01-2345-4678-9abc-def012345678`,
  };
  const savedTurn = [
    {
      id: "a0000000-0000-4000-8000-000000000001",
      threadId,
      role: "user",
      content: "Explain my lease renewal.",
      position: 3,
      createdAt: "2026-11-19T00:00:00.000Z",
      model: null,
      provider: null,
    },
    {
      id: "a0000000-0000-4000-8000-000000000002",
      threadId,
      role: "assistant",
      content: "The saved answer.",
      position: 4,
      createdAt: "2026-11-19T00:00:01.000Z",
      model: "saved-model",
      provider: "saved-provider",
      toolActivity: [{ id: "search-1", status: "done", query: "lease renewal" }],
      files: [download],
    },
  ];
  const request = (extra: Record<string, unknown> = {}) =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        stream,
        messages: [{ role: "user", content: "Explain my lease renewal." }],
        ...extra,
      }),
    });
  async function completion(response: Response) {
    if (!stream) return response.json();
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return events.at(-1);
  }
  let releaseLease: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    releaseLease = vi.fn().mockResolvedValue(undefined);
    auth.mockResolvedValue({ userId: "owner" });
    claimGenerationOperation.mockResolvedValue(releaseLease);
    admitChat.mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
      quota: quota(1),
    });
    getUserSettingsByUserId.mockResolvedValue({ primaryModel: "selected-model" });
    getModelAvailabilitySnapshot.mockResolvedValue({
      availablePrimaryModels: ["selected-model"],
      availableImageInputModels: [],
      imageGenerationAvailable: false,
    });
    getRecentChatMessagesForThreadForUser.mockResolvedValue([]);
    getChatTurnByTurnId.mockResolvedValue(null);
    generateChatTitle.mockResolvedValue(null);
    generateChatReply.mockResolvedValue(reply);
    generateChatReplyStream.mockImplementation(async function* () {
      yield { type: "delta", text: reply.message };
      yield { type: "done", reply };
    });
    appendChatMessagesToThread.mockResolvedValue([]);
  });

  it("returns an already-saved turn without generating, charging quota or saving again", async () => {
    getChatTurnByTurnId.mockResolvedValue(savedTurn);

    const response = await POST(request({ turnId }));

    expect(response.status).toBe(200);
    expect(response.headers.get("RateLimit")).toBeNull();
    const result = await completion(response);
    expect(result).toEqual({
      ...(stream ? { type: "done" } : {}),
      storedMessages: savedTurn,
      message: "The saved answer.",
      provider: "saved-provider",
      model: "saved-model",
      mode: "chat",
      persisted: true,
      toolActivity: savedTurn[1]!.toolActivity,
      webSearchQuery: null,
      webSearchAttempts: [],
      webSearchSuccessfulCount: 0,
      webSources: [],
      files: [download],
    });
    expect(getChatTurnByTurnId).toHaveBeenCalledExactlyOnceWith("owner", threadId, turnId);
    expect(admitChat).not.toHaveBeenCalled();
    expect(generateChatReply).not.toHaveBeenCalled();
    expect(generateChatReplyStream).not.toHaveBeenCalled();
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it("answers a new turn id normally and saves it with the turn", async () => {
    const result = await completion(await POST(request({ turnId: turnId.toUpperCase() })));

    expect(result.message).toBe(reply.message);
    expect(result.persisted).toBe(true);
    expect(getChatTurnByTurnId).toHaveBeenCalledExactlyOnceWith("owner", threadId, turnId);
    expect(admitChat).toHaveBeenCalledExactlyOnceWith("owner");
    expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "owner", threadId, turnId }),
    );
  });

  it("keeps today's path for a request without a turn id", async () => {
    const result = await completion(await POST(request()));

    expect(result.message).toBe(reply.message);
    expect(getChatTurnByTurnId).not.toHaveBeenCalled();
    expect(admitChat).toHaveBeenCalledExactlyOnceWith("owner");
    expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ threadId, turnId: null }),
    );
  });

  it.each([["not-a-uuid"], [42], [""], [{ id: turnId }]])(
    "rejects turn id %j before any lease, admission or model work",
    async (value) => {
      const response = await POST(request({ turnId: value }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "turnId must be a UUID." });
      expect(claimGenerationOperation).not.toHaveBeenCalled();
      expect(getChatTurnByTurnId).not.toHaveBeenCalled();
      expect(admitChat).not.toHaveBeenCalled();
      expect(generateChatReply).not.toHaveBeenCalled();
      expect(generateChatReplyStream).not.toHaveBeenCalled();
    },
  );

  it("generates a new answer for an interrupted turn and leaves its earlier attempt out of history", async () => {
    // The database reports no finished turn for an interrupted one, so the route generates.
    getChatTurnByTurnId.mockResolvedValue(null);
    getRecentChatMessagesForThreadForUser.mockResolvedValue([
      { ...savedTurn[0], content: "An earlier question", position: 1 },
      { ...savedTurn[1], content: "An earlier answer", position: 2, files: undefined },
      { ...savedTurn[0], id: "q", position: 3, turnId },
      { ...savedTurn[1], id: "partial", content: "Renewal ext", position: 4, interrupted: "stopped" },
    ]);

    const result = await completion(await POST(request({ turnId })));

    expect(result.message).toBe(reply.message);
    expect(admitChat).toHaveBeenCalledExactlyOnceWith("owner");
    const generate = stream ? generateChatReplyStream : generateChatReply;
    expect(generate).toHaveBeenCalledOnce();
    const prompt = generate.mock.calls[0]![0] as { role: string; content: string }[];
    expect(prompt.slice(1).map((message) => message.content)).toEqual([
      "An earlier question",
      "An earlier answer",
      "Explain my lease renewal.",
    ]);
    // The database replaces the interrupted rows when it sees the same turn id.
    expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ threadId, turnId }),
    );
  });

  it("labels an earlier interrupted reply as unfinished when it is history for a new turn", async () => {
    getRecentChatMessagesForThreadForUser.mockResolvedValue([
      { ...savedTurn[0], turnId: "c3d4e5f6-0000-4000-8000-000000000000" },
      { ...savedTurn[1], content: "Renewal ext", files: undefined, interrupted: "error" },
    ]);

    await completion(await POST(request({ turnId })));

    const generate = stream ? generateChatReplyStream : generateChatReply;
    const prompt = generate.mock.calls[0]![0] as { role: string; content: string }[];
    expect(prompt.slice(1)).toEqual([
      expect.objectContaining({ role: "user", content: "Explain my lease renewal." }),
      expect.objectContaining({
        role: "assistant",
        content: "Renewal ext\n\n[This reply was interrupted before it finished.]",
      }),
      expect.objectContaining({ role: "user", content: "Explain my lease renewal." }),
    ]);
  });

  it("ignores a turn id in temporary chat, valid or not", async () => {
    for (const value of [turnId, "not-a-uuid"]) {
      const result = await completion(
        await POST(request({ temporary: true, threadId: undefined, turnId: value })),
      );
      expect(result.message).toBe(reply.message);
    }
    expect(claimGenerationOperation).not.toHaveBeenCalled();
    expect(getChatTurnByTurnId).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });
});

describe("interrupted saved-chat streams", () => {
  const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
  const turnId = "6f1c2b9e-8d4a-4b7c-9e2f-0a1b2c3d4e5f";
  const file = {
    id: "abcdef01-2345-4678-9abc-def012345678",
    name: "terms.txt",
    mediaType: "text/plain",
    size: 12,
    text: "Private terms",
  };
  const request = (extra: Record<string, unknown> = {}) =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        turnId,
        stream: true,
        messages: [{ role: "user", content: "Explain my lease renewal." }],
        ...extra,
      }),
    });
  let releaseLease: ReturnType<typeof vi.fn>;

  /** Stream these deltas, then wait for the request to be cancelled, as a slow model would. */
  function streamUntilAborted(texts: string[]) {
    generateChatReplyStream.mockImplementation(async function* (
      _messages: unknown,
      options: { signal: AbortSignal },
    ) {
      for (const text of texts) yield { type: "delta", text };
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
    });
  }

  /** Read the given number of events, then stop reading as Stop or a closed tab does. */
  async function disconnectAfter(response: Response, events: number) {
    const reader = response.body!.getReader();
    for (let index = 0; index < events; index += 1) await reader.read();
    await reader.cancel();
    await runAfterTasks();
  }

  beforeEach(() => {
    releaseLease = vi.fn().mockResolvedValue(undefined);
    auth.mockResolvedValue({ userId: "owner" });
    claimGenerationOperation.mockResolvedValue(releaseLease);
    admitChat.mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
      quota: quota(1),
    });
    getUserSettingsByUserId.mockResolvedValue({ primaryModel: "selected-model" });
    getModelAvailabilitySnapshot.mockResolvedValue({
      availablePrimaryModels: ["selected-model"],
      availableImageInputModels: [],
      imageGenerationAvailable: false,
    });
    getRecentChatMessagesForThreadForUser.mockResolvedValue([]);
    getChatTurnByTurnId.mockResolvedValue(null);
    generateChatTitle.mockResolvedValue(null);
    appendChatMessagesToThread.mockResolvedValue([]);
  });

  it("saves the question, its files and the streamed text, marked interrupted, when the client disconnects", async () => {
    getChatDocumentsForUser.mockResolvedValue([file]);
    streamUntilAborted(["Renewal ", "extends"]);

    await disconnectAfter(
      await POST(
        request({
          messages: [{ role: "user", content: "Explain my lease renewal.", fileIds: [file.id] }],
        }),
      ),
      2,
    );

    expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      threadId,
      turnId,
      generatedTitle: null,
      signal: expect.any(AbortSignal),
      messages: [
        {
          role: "user",
          content: "Explain my lease renewal.",
          metadata: { files: [savedChatFile(file, threadId)] },
        },
        {
          role: "assistant",
          content: "Renewal extends",
          metadata: { interrupted: true, interruptedReason: "stopped" },
        },
      ],
    });
    // Saved under the thread's lease, so a retry cannot start before the turn is on record.
    expect(appendChatMessagesToThread.mock.invocationCallOrder[0]).toBeLessThan(
      releaseLease.mock.invocationCallOrder[0]!,
    );
  });

  it("saves only the question, marked interrupted, when no reply text had streamed", async () => {
    streamUntilAborted([]);

    await disconnectAfter(await POST(request()), 0);

    expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        turnId,
        messages: [
          {
            role: "user",
            content: "Explain my lease renewal.",
            metadata: { interrupted: true, interruptedReason: "stopped" },
          },
        ],
      }),
    );
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it("stores a partial reply as unverifiable when it may restate contract text", async () => {
    // Read this turn: a contract tool ran before the reply was cut off.
    generateChatReplyStream.mockImplementation(async function* (
      _messages: unknown,
      options: { signal: AbortSignal },
    ) {
      yield {
        type: "tool",
        activity: { id: "c1", tool: "read_contract", status: "complete", query: "Lease" },
      };
      yield { type: "delta", text: "Clause 4 says" };
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
    });
    await disconnectAfter(await POST(request()), 2);
    // Inherited: the history it builds on carries contract receipts.
    getRecentChatMessagesForThreadForUser.mockResolvedValue([
      {
        id: "a1", threadId, role: "assistant", content: "Clause 4 renews yearly.", position: 2,
        createdAt: "2026-11-19T00:00:00.000Z", model: null, provider: null,
        contractEvidence: [{ id: "c0000000-0000-4000-8000-000000000001", revision: "rev" }],
      },
    ]);
    after.mockClear();
    streamUntilAborted(["It renews"]);
    await disconnectAfter(await POST(request()), 1);

    expect(appendChatMessagesToThread).toHaveBeenCalledTimes(2);
    for (const [call] of appendChatMessagesToThread.mock.calls)
      expect(call.messages[1].metadata).toEqual({
        interrupted: true,
        interruptedReason: "stopped",
        contractEvidenceInvalid: true,
      });
  });

  it("writes nothing for an interrupted temporary chat", async () => {
    streamUntilAborted(["Renewal "]);

    await disconnectAfter(
      await POST(request({ temporary: true, threadId: undefined })),
      1,
    );

    expect(generateChatReplyStream).toHaveBeenCalledOnce();
    expect(claimGenerationOperation).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });

  it("does not save the turn again after the finished reply was saved", async () => {
    const reply = { message: "Renewal extends the term.", model: "m", provider: "p", webSearch: null };
    generateChatReplyStream.mockImplementation(async function* () {
      yield { type: "delta", text: reply.message };
      yield { type: "done", reply };
    });

    const response = await POST(request());
    await response.text();
    await runAfterTasks();

    expect(appendChatMessagesToThread).toHaveBeenCalledOnce();
    expect(appendChatMessagesToThread.mock.calls[0]![0].messages[1].metadata).not.toHaveProperty(
      "interrupted",
    );
  });

  it("logs a failed interrupted-turn save without changing the response or holding the lease", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    appendChatMessagesToThread.mockRejectedValue(new Error("db down"));
    generateChatReplyStream.mockImplementation(async function* () {
      yield { type: "delta", text: "Renewal " };
      throw new Error("Provider failed");
    });

    const response = await POST(request());
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await runAfterTasks();

    expect(events).toEqual([
      { type: "delta", text: "Renewal " },
      { type: "error", error: "Chat request failed. Please try again." },
    ]);
    expect(appendChatMessagesToThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "user" }),
          {
            role: "assistant",
            content: "Renewal",
            metadata: { interrupted: true, interruptedReason: "error" },
          },
        ],
      }),
    );
    expect(error).toHaveBeenCalledWith(
      "Chat persist (interrupted) failed:",
      expect.objectContaining({ message: "db down" }),
    );
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it("gives up waiting on a stalled interrupted-turn save and still releases the lease", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    appendChatMessagesToThread.mockReturnValue(new Promise(() => {}));
    streamUntilAborted(["Renewal "]);

    const reader = (await POST(request())).body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(appendChatMessagesToThread).toHaveBeenCalledOnce());
    expect(releaseLease).not.toHaveBeenCalled();
    const { signal } = appendChatMessagesToThread.mock.calls[0]![0] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await runAfterTasks();

    // The save is cancelled as well, so it cannot commit once the lease is gone.
    expect(signal.aborted).toBe(true);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Chat persist (interrupted) failed:",
      expect.objectContaining({ message: "Timed out saving the interrupted chat turn." }),
    );
  });
});
