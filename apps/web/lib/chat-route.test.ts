import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  claimGenerationOperation,
  admitChat,
  appendChatMessagesToThread,
  getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId,
  getChatDocumentsForUser,
  getModelAvailabilitySnapshot,
  generateChatTitle,
  generateChatReply,
  generateChatReplyStream,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  claimGenerationOperation: vi.fn(),
  admitChat: vi.fn(),
  appendChatMessagesToThread: vi.fn(),
  getRecentChatMessagesForThreadForUser: vi.fn(),
  getUserSettingsByUserId: vi.fn(),
  getChatDocumentsForUser: vi.fn(),
  getModelAvailabilitySnapshot: vi.fn(),
  generateChatTitle: vi.fn(),
  generateChatReply: vi.fn(),
  generateChatReplyStream: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  claimGenerationOperation,
  appendChatMessagesToThread,
  getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId,
  getChatDocumentsForUser,
}));
vi.mock("@/lib/chat-title", () => ({ generateChatTitle }));
vi.mock("@/lib/chat", () => ({ generateChatReply, generateChatReplyStream }));
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
import { validateContractReplay } from "@/lib/contract-evidence";
import {
  MAX_CHAT_REQUEST_BODY_BYTES,
  MAX_CHAT_DOCUMENT_REQUEST_BODY_BYTES,
} from "./chat-history-bounds";

const resetAt = "2026-10-19T15:00:00.000Z";
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
      imageGenerationAvailable: false,
    });
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
    } else {
      expect(generateChatReply).toHaveBeenCalled();
      controller.abort();
      await response;
    }
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
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
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
  });
});
