import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { fenceUntrusted } from "@repo/chat-engine/chat-tools";

// A saved chat about one contract, through the real route and generator; only the model, database
// and account edges are fake, so the test sees the exact prompt and tools the model receives.
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  claimGenerationOperation: vi.fn(),
  admitChat: vi.fn(),
  appendChatMessagesToThread: vi.fn(),
  getRecentChatMessagesForThreadForUser: vi.fn(),
  getUserSettingsByUserId: vi.fn(),
  getModelAvailabilitySnapshot: vi.fn(),
  listContractsForChat: vi.fn(),
  getContractWindowForUser: vi.fn(),
  getChatFocusContractForUser: vi.fn(),
  getChatThreadFocusForUser: vi.fn(),
  getChatTurnByTurnId: vi.fn(),
  generateChatTitle: vi.fn(),
  responses: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/server-db", () => ({
  claimGenerationOperation: mocks.claimGenerationOperation,
  appendChatMessagesToThread: mocks.appendChatMessagesToThread,
  getRecentChatMessagesForThreadForUser:
    mocks.getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId: mocks.getUserSettingsByUserId,
  listContractsForChat: mocks.listContractsForChat,
  getContractTextForUser: vi.fn(),
  getContractWindowForUser: mocks.getContractWindowForUser,
  getChatFocusContractForUser: mocks.getChatFocusContractForUser,
  getChatThreadFocusForUser: mocks.getChatThreadFocusForUser,
  getChatTurnByTurnId: mocks.getChatTurnByTurnId,
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ responses: mocks.responses }),
}));
vi.mock("@/lib/llm-client", () => ({
  APP_NAME: "SignLoop",
  SITE_URL: "https://signloop.test",
  PRIMARY_LLM_BASE_URL: "https://primary.test/v1",
  PRIMARY_LLM_API_KEY: "test",
  OPENROUTER_BASE_URL: "https://fallback.test/v1",
  OPENROUTER_API_KEY: "test",
  OPENROUTER_MODELS: ["fallback"],
  isOpenRouterModel: () => false,
  resolvePrimaryModel: (value: string | null | undefined) =>
    value === null ? null : (value ?? "primary"),
}));
vi.mock("@repo/chat-engine/web-search", () => ({ searchWeb: vi.fn() }));
vi.mock("@repo/chat-engine/url-reader", () => ({ readUrl: vi.fn() }));
vi.mock("@repo/chat-engine/http-fetch", () => ({ httpGet: vi.fn() }));
vi.mock("@repo/chat-engine/image-generation", () => ({ generateImageReply: vi.fn() }));
vi.mock("@/lib/chat-title", () => ({ generateChatTitle: mocks.generateChatTitle }));
vi.mock("@/lib/model-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-settings")>()),
  getModelAvailabilitySnapshot: mocks.getModelAvailabilitySnapshot,
}));
vi.mock("@/lib/chat-admission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-admission")>()),
  admitChat: mocks.admitChat,
}));
vi.mock("@/lib/telemetry", () => ({
  isTelemetryEnabled: false,
  flushTelemetry: vi.fn(),
}));

import { POST } from "@/app/api/chat/route";

const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const contractId = "33333333-3333-4333-8333-333333333333";
const otherContractId = "44444444-4444-4444-8444-444444444444";
const turnId = "55555555-5555-4555-8555-555555555555";
const contract = {
  id: contractId,
  title: "Office lease for Example Holdings",
  confirmedJurisdiction: null as string | null,
};
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textOnlyModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: text },
            { type: "text-end", id: "text" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
        }),
      }) as Awaited<ReturnType<MockLanguageModelV4["doStream"]>>,
  });
}

function savedRow(position: number, role: "user" | "assistant", content: string) {
  return {
    id: `00000000-0000-4000-8000-00000000000${position}`,
    threadId,
    role,
    content,
    position,
    createdAt: "2026-11-22T00:00:00.000Z",
    toolActivity: [],
    model: null,
    provider: null,
  };
}

let model: MockLanguageModelV4;

beforeEach(() => {
  mocks.auth.mockResolvedValue({ userId: "owner" });
  mocks.claimGenerationOperation.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
  mocks.admitChat.mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) });
  mocks.getUserSettingsByUserId.mockResolvedValue(null);
  mocks.getModelAvailabilitySnapshot.mockResolvedValue({
    availablePrimaryModels: ["primary"],
    imageGenerationAvailable: false,
  });
  mocks.appendChatMessagesToThread.mockResolvedValue([]);
  mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([]);
  mocks.getChatThreadFocusForUser.mockResolvedValue(null);
  mocks.getChatFocusContractForUser.mockResolvedValue(null);
  mocks.getChatTurnByTurnId.mockResolvedValue(null);
  mocks.generateChatTitle.mockResolvedValue(null);
  model = textOnlyModel("Clause 4 says the notice period is sixty days.");
  mocks.responses.mockReturnValue(model);
});

afterEach(() => {
  vi.resetAllMocks();
});

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      messages: [{ role: "user", content: "Can I end this early?" }],
      ...body,
    }),
  });
}

/** The system text the model received: SignLoop's prompt plus the engine's tool notes. */
function systemPrompt(): string {
  const prompt = model.doStreamCalls[0]?.prompt ?? [];
  return prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

function offeredTools(): string[] {
  return (model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name);
}

function savedUserMetadata() {
  const call = mocks.appendChatMessagesToThread.mock.calls[0]?.[0] as {
    messages: Array<{ role: string; metadata?: Record<string, unknown> }>;
  };
  return call.messages.find((message) => message.role === "user")?.metadata;
}

function expectNothingSpent() {
  expect(mocks.claimGenerationOperation).not.toHaveBeenCalled();
  expect(mocks.admitChat).not.toHaveBeenCalled();
  expect(mocks.responses).not.toHaveBeenCalled();
  expect(model.doStreamCalls).toHaveLength(0);
  expect(mocks.appendChatMessagesToThread).not.toHaveBeenCalled();
}

describe.each([false, true])("a saved chat about one contract (stream=%s)", (stream) => {
  async function send(body: Record<string, unknown>) {
    const response = await POST(request({ stream, ...body }));
    const text = await response.text();
    return { status: response.status, text };
  }

  it("names the owner's contract in the system note on the first turn and stores the focus with it", async () => {
    mocks.getChatFocusContractForUser.mockResolvedValue(contract);

    expect((await send({ focusContractId: contractId.toUpperCase() })).status).toBe(200);

    expect(mocks.getChatThreadFocusForUser).toHaveBeenCalledWith("owner", threadId);
    expect(mocks.getChatFocusContractForUser).toHaveBeenCalledWith("owner", contractId);
    const system = systemPrompt();
    expect(system).toContain(`This conversation is about one of the user's contracts, id ${contractId}.`);
    expect(system).toContain(fenceUntrusted(contract.title));
    expect(system).toContain(`call read_contract with contractId ${contractId} first`);
    expect(system).toContain("The user has not confirmed a jurisdiction for this contract");
    expect(offeredTools()).toEqual(expect.arrayContaining(["read_contract", "list_contracts"]));
    // Only the note names the contract: its text is read through read_contract, never inlined.
    expect(mocks.getContractWindowForUser).not.toHaveBeenCalled();
    expect(savedUserMetadata()).toEqual({ focusContractId: contractId });
  });

  it("includes the jurisdiction the owner confirmed", async () => {
    mocks.getChatFocusContractForUser.mockResolvedValue({
      ...contract,
      confirmedJurisdiction: "England and Wales",
    });

    await send({ focusContractId: contractId });

    expect(systemPrompt()).toContain(fenceUntrusted("England and Wales"));
    expect(systemPrompt()).not.toContain("has not confirmed");
  });

  it("answers a contract that is missing or another user's with the same 404, before any lease, quota, model or save", async () => {
    mocks.getChatFocusContractForUser.mockResolvedValue(null);

    const response = await send({ focusContractId: contractId });

    expect(response.status).toBe(404);
    expect(JSON.parse(response.text)).toEqual({ error: "Contract not found" });
    expect(mocks.getChatFocusContractForUser).toHaveBeenCalledWith("owner", contractId);
    expectNothingSpent();
  });

  it("rejects a malformed focus before touching the database", async () => {
    const response = await send({ focusContractId: "not-a-uuid" });

    expect(response.status).toBe(400);
    expect(mocks.getChatThreadFocusForUser).not.toHaveBeenCalled();
    expectNothingSpent();
  });

  it("keeps the thread's stored focus on a follow-up turn that sends none, checking ownership again", async () => {
    mocks.getChatThreadFocusForUser.mockResolvedValue({ contractId, contract });
    mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
      savedRow(1, "user", "What is the notice period?"),
      savedRow(2, "assistant", "Sixty days."),
    ]);

    expect((await send({})).status).toBe(200);

    // The stored focus came with the owner's contract, so no client value was needed.
    expect(mocks.getChatFocusContractForUser).not.toHaveBeenCalled();
    expect(systemPrompt()).toContain(`id ${contractId}`);
    expect(savedUserMetadata()).toEqual({ focusContractId: contractId });
  });

  it("keeps the focus on a retry of the interrupted first turn", async () => {
    mocks.getChatThreadFocusForUser.mockResolvedValue({ contractId, contract });
    mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
      { ...savedRow(1, "user", "Can I end this early?"), turnId, interrupted: "stopped" },
    ]);

    expect((await send({ turnId, focusContractId: contractId })).status).toBe(200);

    expect(systemPrompt()).toContain(`id ${contractId}`);
    expect(mocks.appendChatMessagesToThread).toHaveBeenCalledWith(
      expect.objectContaining({ turnId }),
    );
    expect(savedUserMetadata()).toEqual({ focusContractId: contractId });
  });

  it("replays a retried first turn that another request saved while this one waited, instead of refusing it", async () => {
    // Before the lease the thread had no focus yet; under the lease the overlapping request has
    // saved the turn, with its focus, so the retry gets that saved answer back.
    mocks.getChatThreadFocusForUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ contractId, contract });
    mocks.getChatFocusContractForUser.mockResolvedValue(contract);
    mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
      { ...savedRow(1, "user", "Can I end this early?"), turnId },
      savedRow(2, "assistant", "Clause 9 allows it."),
    ]);
    mocks.getChatTurnByTurnId.mockResolvedValue([
      { ...savedRow(1, "user", "Can I end this early?"), turnId },
      savedRow(2, "assistant", "Clause 9 allows it."),
    ]);

    const response = await send({ turnId, focusContractId: contractId });

    expect(response.status).toBe(200);
    expect(response.text).toContain("Clause 9 allows it.");
    expect(mocks.getChatThreadFocusForUser).toHaveBeenCalledTimes(2);
    expect(mocks.admitChat).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
    expect(mocks.appendChatMessagesToThread).not.toHaveBeenCalled();
  });

  it("refuses a client focus that conflicts with the thread's stored one, never merging them", async () => {
    mocks.getChatThreadFocusForUser.mockResolvedValue({ contractId, contract });

    const response = await send({ focusContractId: otherContractId });

    expect(response.status).toBe(409);
    expect(mocks.getChatFocusContractForUser).not.toHaveBeenCalled();
    expectNothingSpent();
  });

  it("refuses to turn an ordinary chat with history into a focused one", async () => {
    mocks.getChatFocusContractForUser.mockResolvedValue(contract);
    mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
      savedRow(1, "user", "Hello"),
      savedRow(2, "assistant", "Hi there."),
    ]);

    const response = await send({ focusContractId: contractId });

    expect(response.status).toBe(409);
    expect(mocks.admitChat).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
    expect(mocks.appendChatMessagesToThread).not.toHaveBeenCalled();
  });

  it("answers unfocused, without storing a focus, once the thread's contract was deleted", async () => {
    mocks.getChatThreadFocusForUser.mockResolvedValue({ contractId, contract: null });
    mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
      savedRow(1, "user", "What is the notice period?"),
      savedRow(2, "assistant", "Sixty days."),
    ]);

    // Even the deleted contract's own id, sent by a page that has not noticed yet, is not a 404.
    expect((await send({ focusContractId: contractId })).status).toBe(200);

    expect(systemPrompt()).not.toContain("This conversation is about one of the user's contracts");
    expect(savedUserMetadata()).toBeUndefined();
  });

  it("adds no focus note to an ordinary saved chat", async () => {
    expect((await send({})).status).toBe(200);

    expect(mocks.getChatFocusContractForUser).not.toHaveBeenCalled();
    expect(systemPrompt()).not.toContain("This conversation is about one of the user's contracts");
    expect(savedUserMetadata()).toBeUndefined();
  });
});

describe.each([
  ["signed-in", "owner"],
  ["anonymous", null],
])("%s temporary chat", (_label, userId) => {
  it("ignores focusContractId, valid or not, and never looks up a contract", async () => {
    mocks.auth.mockResolvedValue({ userId });
    for (const focusContractId of [contractId, "not-a-uuid"]) {
      const response = await POST(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            temporary: true,
            focusContractId,
            messages: [{ role: "user", content: "Can I end this early?" }],
          }),
        }),
      );
      expect(response.status).toBe(200);
    }

    expect(mocks.getChatThreadFocusForUser).not.toHaveBeenCalled();
    expect(mocks.getChatFocusContractForUser).not.toHaveBeenCalled();
    expect(mocks.appendChatMessagesToThread).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(systemPrompt()).not.toContain("This conversation is about one of the user's contracts");
  });
});
