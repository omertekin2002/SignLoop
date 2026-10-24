import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRoutedModel, type ChatProviderCandidate } from "./routing";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type StepResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
const answering = () =>
  new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "Answer" },
            { type: "text-end", id: "text" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
        }),
      }) as StepResult,
  });
const failing = (error: unknown) =>
  new MockLanguageModelV4({
    doStream: async () => {
      throw error;
    },
  });
const silent = () =>
  new MockLanguageModelV4({ doStream: () => new Promise(() => {}) });
function candidate(
  provider: string,
  languageModel: MockLanguageModelV4,
  extra: Partial<ChatProviderCandidate> = {},
): ChatProviderCandidate {
  return {
    kind: "language-model",
    provider,
    model: `${provider}-model`,
    languageModel,
    ...extra,
  } as ChatProviderCandidate;
}

describe("createRoutedModel", () => {
  it("refuses an empty provider chain", () => {
    expect(() => createRoutedModel([])).toThrow("No chat provider is configured");
  });

  it("merges a candidate's provider options over the request's", async () => {
    const gemini = answering();
    const routed = createRoutedModel([
      candidate("gemini", gemini, {
        providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } },
      }),
    ]);
    await routed.model.doStream({
      prompt: [],
      providerOptions: { openai: { store: false } },
    });
    expect(gemini.doStreamCalls[0]?.providerOptions).toEqual({
      openai: { store: false },
      google: { thinkingConfig: { thinkingLevel: "high" } },
    });
  });

  it("gives each candidate its own opening deadline", async () => {
    const slow = silent();
    const patient = silent();
    const fallback = answering();
    const failures: unknown[] = [];
    const routed = createRoutedModel(
      [
        candidate("primary", slow),
        candidate("gemini", patient, { firstChunkTimeoutMs: 60 }),
        candidate("openrouter", fallback),
      ],
      { firstChunkTimeoutMs: 20, onProviderFailure: (failure) => failures.push(failure) },
    );
    const started = performance.now();
    await routed.model.doStream({ prompt: [] });
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
    expect(routed.selected()).toEqual({ provider: "openrouter", model: "openrouter-model" });
    expect(failures).toEqual([
      { provider: "primary", model: "primary-model", errorClass: "FirstChunkTimeoutError" },
      { provider: "gemini", model: "gemini-model", errorClass: "FirstChunkTimeoutError" },
    ]);
  });

  it("stops the chain when a candidate declines to fall back", async () => {
    const rejected = Object.assign(new Error("bad request"), { status: 400 });
    const next = answering();
    const exhausted = new Error("all providers unavailable");
    const createExhaustedError = vi.fn(() => exhausted);
    const routed = createRoutedModel(
      [
        candidate("openrouter", failing(rejected), {
          shouldFallback: (error) => (error as { status?: number }).status !== 400,
        }),
        candidate("openrouter", next),
      ],
      { onProviderFailure: () => {}, createExhaustedError },
    );
    await expect(routed.model.doStream({ prompt: [] })).rejects.toBe(exhausted);
    expect(createExhaustedError).toHaveBeenCalledWith(
      [{ provider: "openrouter", model: "openrouter-model", errorClass: "Error", statusCode: 400 }],
      rejected,
    );
    expect(next.doStreamCalls).toHaveLength(0);
  });

  it("rethrows the last failure by default once every candidate has failed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const last = new Error("second failure");
    const routed = createRoutedModel([
      candidate("primary", failing(new Error("first failure"))),
      candidate("openrouter", failing(last)),
    ]);
    await expect(routed.model.doStream({ prompt: [] })).rejects.toBe(last);
    expect(warned.mock.calls.map(([message]) => message)).toEqual([
      "Chat provider step failed",
      "Chat provider step failed",
    ]);
    warned.mockRestore();
  });
});
