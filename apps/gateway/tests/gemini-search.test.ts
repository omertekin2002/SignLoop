// Ported from SignLoop at 61c90b508a789cee988acdded52b2d1a8c82ee69.
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWeb as search } from "../src/pipeline/gemini-search";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function groundedResponse(input?: {
  text?: string;
  queries?: string[];
  chunks?: unknown[];
  supports?: unknown[];
}): Response {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [
            { text: input?.text?.slice(0, 5) ?? "Fresh" },
            { text: input?.text?.slice(5) ?? " research brief" },
          ],
        },
        groundingMetadata: {
          webSearchQueries: input?.queries ?? ["latest answer"],
          groundingChunks: input?.chunks ?? [
            {
              web: {
                uri: "https://example.com/source",
                title: "Example source",
              },
            },
          ],
          groundingSupports: input?.supports ?? [
            {
              segment: { text: "Supported fact" },
              groundingChunkIndices: [0],
            },
          ],
        },
      },
    ],
  });
}

describe("searchWeb", () => {
  it.each([
    ["gemini-2.5-flash", { thinkingBudget: 24_576 }, 26_624],
    ["gemini-2.5-flash-preview-05-20", { thinkingBudget: 24_576 }, 26_624],
    ["gemini-2.5-flash-lite", { thinkingBudget: 24_576 }, 26_624],
    ["gemini-2.5-pro", { thinkingBudget: 32_768 }, 34_816],
    ["models/gemini-2.5-pro", { thinkingBudget: 32_768 }, 34_816],
    ["gemini-3-flash-preview", { thinkingLevel: "HIGH" }, 32_768],
    ["gemini-3.8-flash", { thinkingLevel: "HIGH" }, 32_768],
    ["gemini-4-argon", { thinkingLevel: "HIGH" }, 32_768],
  ] as const)(
    "requests high thinking for %s with room for the grounded brief",
    async (model, thinkingConfig, maxOutputTokens) => {
      const fetchMock = vi.fn().mockResolvedValue(groundedResponse());
      vi.stubGlobal("fetch", fetchMock);

      const result = await search("current regulations", {
        apiKey: "test-key",
        model,
      });

      expect(result.brief).toBe("Fresh research brief");
      expect(String(fetchMock.mock.calls[0]![0])).toContain(
        `/models/${model.replace(/^models\//, "")}:generateContent`,
      );
      const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(request.generationConfig).toEqual({
        temperature: 0.1,
        thinkingConfig,
        maxOutputTokens,
      });
      expect(request.tools).toEqual([{ google_search: {} }]);
    },
  );

  it("executes the model's query and returns structured grounded evidence", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(groundedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("current regulations");
    expect(result.brief).toBe("Fresh research brief");
    expect(result.metadata.sources).toEqual([
      {
        title: "Example source",
        url: "https://example.com/source",
        snippet: "Supported fact",
      },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.contents[0].parts[0].text).toContain("current regulations");
  });

  it("fails before fetch when Gemini search is not configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("Search this")).rejects.toMatchObject({
      name: "GeminiWebSearchError",
      message: expect.stringMatching(/GEMINI_API_KEY/),
      publicMessage: expect.stringMatching(/not configured correctly/i),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Gemini returns ungrounded text", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(async () =>
        Response.json({
          candidates: [
            { content: { parts: [{ text: "Answer from memory" }] } },
          ],
        }),
      ),
    );

    await expect(searchWeb("Search this")).rejects.toThrow(
      /without Google Search grounding/,
    );
  });

  it("does not treat a truncated no-search response as a completed decision", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          candidates: [
            {
              finishReason: "MAX_TOKENS",
              content: { parts: [{ text: "NO_SEARCH_NEEDED" }] },
            },
          ],
        }),
      ),
    );
    await expect(searchWeb("Research current regulations")).rejects.toThrow(
      /without Google Search grounding/,
    );
  });

  it("reports sanitized Gemini API errors without putting the key in the URL", async () => {
    vi.stubEnv("GEMINI_API_KEY", "never-leak-this-key");
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json(
        {
          error: {
            message: "Quota exhausted for never-leak-this-key key=also-secret",
          },
        },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = searchWeb("Search this");

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Gemini web search failed (429): Quota exhausted",
    );
    expect((error as Error).message).not.toContain("never-leak-this-key");
    expect((error as Error).message).not.toContain("also-secret");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(
      "never-leak-this-key",
    );
  });

  it("propagates caller cancellation", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-secret");
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(async (_input, init) => {
        if (init?.signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        return groundedResponse();
      }),
    );

    await expect(
      searchWeb("Search this", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts an in-flight Gemini request when the caller cancels", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-secret");
    const controller = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? null;
            started();
            requestSignal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted", "AbortError"),
                ),
              { once: true },
            );
          }),
      ),
    );

    const promise = searchWeb("Search this", { signal: controller.signal });
    const rejection = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    await requestStarted;
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(false);
    controller.abort();
    await rejection;
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("times out a stalled Gemini response with a safe public error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GEMINI_API_KEY", "gemini-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted", "AbortError"),
                ),
              { once: true },
            );
          }),
      ),
    );

    const promise = searchWeb("Search this");
    const rejection = expect(promise).rejects.toMatchObject({
      name: "GeminiWebSearchError",
      message: expect.stringMatching(/timed out/i),
      publicMessage: expect.stringMatching(/timed out/i),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });
});

function searchWeb(query: string, options?: { signal?: AbortSignal }) {
  return search(query, { ...options, apiKey: process.env.GEMINI_API_KEY });
}
