import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  claimGenerationOperation,
  admitChat,
  appendChatMessagesToThread,
  getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId,
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
  getModelAvailabilitySnapshot: vi.fn(),
  generateChatTitle: vi.fn(),
  generateChatReply: vi.fn(),
  generateChatReplyStream: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  claimGenerationOperation,
  appendChatMessagesToThread,
  getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId,
}));
vi.mock("@/lib/chat-title", () => ({ generateChatTitle }));
vi.mock("@/lib/chat", () => ({ generateChatReply, generateChatReplyStream }));
vi.mock("@/lib/model-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-settings")>()),
  getModelAvailabilitySnapshot,
}));
vi.mock("@/lib/chat-admission", () => ({ admitChat }));
vi.mock("@/lib/telemetry", () => ({
  isTelemetryEnabled: false,
  flushTelemetry: vi.fn(),
}));

import { POST } from "@/app/api/chat/route";

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
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
      expect.objectContaining({ primaryModel: "selected-model" }),
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

  it("does not generate a title for temporary chats", async () => {
    await completion(await POST(request({ temporary: true })));
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(appendChatMessagesToThread).not.toHaveBeenCalled();
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
