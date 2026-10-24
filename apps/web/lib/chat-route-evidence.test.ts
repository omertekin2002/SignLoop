import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";

// Drive the real saved-chat route and generator; only the model, database, and account edges are fake.
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
  responses: vi.fn(),
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
vi.mock("@/lib/image-generation", () => ({ generateImageReply: vi.fn() }));
vi.mock("@/lib/chat-title", () => ({ generateChatTitle: vi.fn() }));
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
import { validateContractReplay } from "@/lib/contract-evidence";

const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const receipt = { id: "22222222-2222-4222-8222-222222222222", revision: "v1" };
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A tool-free answer: any dependency on the earlier contract read must be inherited. */
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
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      }) as Awaited<ReturnType<MockLanguageModelV4["doStream"]>>,
  });
}

/** Calls list_contracts, then read_contract with an unknown id, then answers. */
function emptyLookupModel(text: string) {
  const step = (chunks: unknown[]) =>
    ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks,
      }),
    }) as Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
  const toolCall = (id: string, toolName: string, input: unknown) =>
    step([
      { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
      },
    ]);
  const steps = [
    toolCall("c1", "list_contracts", {}),
    toolCall("c2", "read_contract", { contractId: receipt.id }),
  ];
  return new MockLanguageModelV4({
    doStream: async (options) =>
      steps.shift() ?? (await textOnlyModel(text).doStream(options)),
  });
}

function savedRow(
  position: number,
  role: "user" | "assistant",
  content: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `00000000-0000-4000-8000-00000000000${position}`,
    threadId,
    role,
    content,
    position,
    createdAt: "2026-10-20T00:00:00.000Z",
    toolActivity: [],
    model: null,
    provider: null,
    ...extra,
  };
}

beforeEach(() => {
  mocks.auth.mockResolvedValue({ userId: "owner" });
  mocks.claimGenerationOperation.mockResolvedValue(
    vi.fn().mockResolvedValue(undefined),
  );
  mocks.admitChat.mockResolvedValue({
    release: vi.fn().mockResolvedValue(undefined),
  });
  mocks.getUserSettingsByUserId.mockResolvedValue(null);
  mocks.getModelAvailabilitySnapshot.mockResolvedValue({
    availablePrimaryModels: ["primary"],
    imageGenerationAvailable: false,
  });
  mocks.appendChatMessagesToThread.mockResolvedValue([]);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe.each([false, true])(
  "saved-chat contract dependencies (stream=%s)",
  (stream) => {
    async function send(content: string) {
      const response = await POST(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            stream,
            messages: [{ role: "user", content }],
          }),
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    function savedAssistantMetadata() {
      const call = mocks.appendChatMessagesToThread.mock.calls[0]?.[0] as {
        userId: string;
        threadId: string;
        messages: Array<{ role: string; metadata?: Record<string, unknown> }>;
      };
      expect(call).toMatchObject({ userId: "owner", threadId });
      return call.messages.find((message) => message.role === "assistant")
        ?.metadata;
    }

    it("saves a tool-free followup with the receipts of the contract answer it builds on", async () => {
      mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
        savedRow(0, "user", "Read my fee agreement"),
        savedRow(1, "assistant", "The fee is $500.", {
          contractEvidence: [receipt],
        }),
        // An unrelated followup that already inherited the dependency keeps carrying it.
        savedRow(2, "user", "Thanks"),
        savedRow(3, "assistant", "You're welcome.", {
          contractEvidence: [receipt],
        }),
      ]);
      const model = textOnlyModel("This means you pay $500 on cancellation.");
      mocks.responses.mockReturnValue(model);

      await send("Explain that fee");

      expect(mocks.getRecentChatMessagesForThreadForUser).toHaveBeenCalledWith(
        "owner",
        threadId,
        expect.any(Number),
      );
      // The model saw the contract-derived prose, so the reply depends on that contract.
      expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
        "The fee is $500.",
      );
      expect(savedAssistantMetadata()?.contractEvidence).toEqual([receipt]);
    });

    it("saves an explicit empty receipt list when contract lookups found nothing", async () => {
      mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
        savedRow(0, "user", "Hello"),
        savedRow(1, "assistant", "Hi there."),
      ]);
      mocks.listContractsForChat.mockResolvedValue({ contracts: [], nextOffset: null });
      mocks.getContractWindowForUser.mockResolvedValue(null);
      mocks.responses.mockReturnValue(
        emptyLookupModel("You have no uploaded contracts yet."),
      );

      await send("Which contracts do I have?");

      expect(mocks.listContractsForChat).toHaveBeenCalledWith("owner", {});
      const metadata = savedAssistantMetadata()!;
      expect(metadata.contractEvidence).toEqual([]);
      expect(metadata.toolActivity).toMatchObject([
        { tool: "list_contracts", status: "complete" },
        { tool: "read_contract", status: "error" },
      ]);
      expect(validateContractReplay(metadata, new Map())).toBe(metadata);
    });

    it("saves no inherited receipts when history never depended on a contract", async () => {
      mocks.getRecentChatMessagesForThreadForUser.mockResolvedValue([
        savedRow(0, "user", "Hello"),
        savedRow(1, "assistant", "Hi there."),
      ]);
      mocks.responses.mockReturnValue(textOnlyModel("Sure."));

      await send("Tell me more");

      expect(savedAssistantMetadata()?.contractEvidence).toEqual([]);
    });
  },
);
