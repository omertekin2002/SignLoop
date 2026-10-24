import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRoutedModel, StreamStallTimeoutError, type ChatProviderCandidate } from "./routing";

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
// Starts answering, then goes quiet without ever finishing; records the abort it receives.
const stalling = () => {
  const aborts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      abortSignal?.addEventListener("abort", () => aborts.push(abortSignal.reason), { once: true });
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({ type: "text-delta", id: "text", delta: "Partial" });
          },
        }),
      } as StepResult;
    },
  });
  return { model, aborts };
};
async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream as unknown as AsyncIterable<unknown>) parts.push(part);
  return parts;
}
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

  it("fails a stream that stalls after it starts answering instead of waiting for the deadline", async () => {
    const { model, aborts } = stalling();
    const failures: unknown[] = [];
    const routed = createRoutedModel([candidate("primary", model)], {
      streamIdleTimeoutMs: 40,
      onProviderFailure: (failure) => failures.push(failure),
    });
    const { stream } = await routed.model.doStream({ prompt: [] });
    const started = performance.now();
    await expect(drain(stream)).rejects.toBeInstanceOf(StreamStallTimeoutError);
    expect(performance.now() - started).toBeLessThan(1000);
    // The provider request itself is cancelled too.
    expect(aborts).toEqual([expect.any(StreamStallTimeoutError)]);
    expect(failures).toEqual([
      { provider: "primary", model: "primary-model", errorClass: "StreamStallTimeoutError" },
    ]);
  });

  it("lets a candidate override or disable the stall limit", async () => {
    const { model } = stalling();
    const routed = createRoutedModel(
      [candidate("primary", model, { streamIdleTimeoutMs: null })],
      { streamIdleTimeoutMs: 20, onProviderFailure: () => {} },
    );
    const { stream } = await routed.model.doStream({ prompt: [] });
    const reader = stream.getReader();
    await reader.read();
    await reader.read();
    const next = reader.read();
    const outcome = await Promise.race([
      next.then(() => "settled", () => "failed"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 100)),
    ]);
    expect(outcome).toBe("still waiting");
    await reader.cancel();
  });

  it("does not time out a stream that keeps producing parts", async () => {
    const steady = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: 15,
            chunks: [
              { type: "text-start", id: "text" },
              ...Array.from({ length: 8 }, () => ({ type: "text-delta" as const, id: "text", delta: "x" })),
              { type: "text-end", id: "text" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
          }),
        }) as StepResult,
    });
    const routed = createRoutedModel([candidate("primary", steady)], { streamIdleTimeoutMs: 40 });
    const { stream } = await routed.model.doStream({ prompt: [] });
    expect(await drain(stream)).toHaveLength(11);
  });
});
