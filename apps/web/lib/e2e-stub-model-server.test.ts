import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STUB_ANALYSIS_FLAGS,
  STUB_ANALYSIS_SUMMARY,
  STUB_CONTRACT_FIXTURE,
  STUB_MODEL,
  STUB_NOTICE_QUOTE,
  STUB_RENEWAL_QUOTE,
  startStubModelServer,
  stubAnalysis,
  stubReply,
  stubTitle,
  type StubModelServer,
} from "@/e2e/stub-model-server";

// The signed-in suite's stub model (e2e/stub-model-server.ts), run against the app's real chat binding and the installed AI
// SDK, outside a browser: if the Responses events it streams stop matching what @ai-sdk/openai
// parses, this fails here rather than as a flaky browser test. Likewise, its fixed analysis runs
// through analyzeText and the citation check, so a change to the analysis schema breaks this test
// rather than only contract-analysis.spec.ts.

let stub: StubModelServer;

beforeEach(async () => {
  // Port 0: any free port, so this never collides with a running signed-in suite.
  stub = await startStubModelServer(0);
  vi.resetModules();
  for (const [name, value] of Object.entries({
    PRIMARY_LLM_BASE_URL: stub.url,
    PRIMARY_LLM_MODEL: STUB_MODEL,
    PRIMARY_LLM_API_KEY: "",
    OPENROUTER_API_KEY: "",
    WEB_SEARCH_PROVIDER: "",
  })) {
    vi.stubEnv(name, value);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await stub.close();
});

describe("the end-to-end stub model", () => {
  it("is discovered as the only primary model, text-only", async () => {
    const { getModelAvailabilitySnapshot } = await import("@/lib/model-settings");
    expect(await getModelAvailabilitySnapshot({ forceRefresh: true })).toEqual({
      availablePrimaryModels: [STUB_MODEL],
      availableImageInputModels: [],
      imageGenerationAvailable: false,
    });
  });

  it("streams its fixed Markdown reply through the chat engine, without calling a tool", async () => {
    const { generateChatReplyStream } = await import("@/lib/chat");
    const question = "What does clause E2E-42 say?";
    const deltas: string[] = [];
    let reply: { message: string; model: string; provider: string; toolActivity?: unknown[] } | null = null;
    for await (const chunk of generateChatReplyStream(
      [
        { role: "system", content: "You are a test assistant." },
        { role: "user", content: question },
      ],
      { primaryModel: STUB_MODEL, enableWebSearch: true, enableUrlReader: true, enableHttpFetch: true },
    )) {
      if (chunk.type === "delta") deltas.push(chunk.text);
      if (chunk.type === "done") reply = chunk.reply;
    }

    expect(reply).toMatchObject({
      message: stubReply(question),
      model: STUB_MODEL,
      provider: "primary-openai-compatible",
    });
    expect(reply!.toolActivity ?? []).toEqual([]);
    // Streamed in several deltas, not as one block.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(stubReply(question));

    const requests = stub.requests();
    expect(requests).toEqual([
      expect.objectContaining({ model: STUB_MODEL, kind: "reply", question }),
    ]);
    // Tools were offered, and the stub answered without using them.
    expect(requests[0]?.tools.length).toBeGreaterThan(0);
  });

  it("answers the app's title request with its fixed title", async () => {
    const { generateChatTitle } = await import("@/lib/chat-title");
    const question = "Does E2E-7 renew?";
    const title = await generateChatTitle(question, {
      primaryModel: STUB_MODEL,
      signal: new AbortController().signal,
    });

    expect(title).toBe(stubTitle(question));
    expect(stub.requests()).toEqual([
      expect.objectContaining({ kind: "title", model: STUB_MODEL }),
    ]);
  });

  it("matches the analysis schema exactly, without the parser's normalization", async () => {
    const { AnalysisResultSchema } = await import("@/lib/schemas");
    const parsed = AnalysisResultSchema.safeParse(stubAnalysis());
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("analyses the fixture contract through analyzeText, with quotations the app verifies", async () => {
    const { analyzeText } = await import("@/lib/analysis");
    const { finalizeAnalysisResult } = await import("@/lib/analysis-sources");
    const { contractAnalysisSegments } = await import("@/lib/source-citations");
    const text = readFileSync(STUB_CONTRACT_FIXTURE, "utf8").trim();
    // One "full" segment, so the stub's evidence labels match and no merge call is made.
    expect(contractAnalysisSegments(text).map((segment) => segment.label)).toEqual(["full"]);

    const analysed = await analyzeText(text, undefined, { primaryModel: STUB_MODEL });
    expect(analysed).toMatchObject({
      provider: "primary-openai-compatible",
      model: STUB_MODEL,
      promptTokens: 100,
      completionTokens: 50,
      result: {
        risk_badge: "MEDIUM",
        summary: { what_it_is: STUB_ANALYSIS_SUMMARY },
      },
    });
    expect(analysed.result.red_flags.map((flag) => flag.type)).toEqual(
      STUB_ANALYSIS_FLAGS.map((flag) => flag.type),
    );

    // What the analyze route stores: every finding keeps a verified citation of its quotation.
    const contractId = "0b6f3a52-5d1e-4c7a-9f1e-2a8d6c4b1e90";
    const stored = finalizeAnalysisResult(analysed.result, { id: contractId, text });
    expect(stored.red_flags).toEqual(
      STUB_ANALYSIS_FLAGS.map(({ quote }) =>
        expect.objectContaining({
          citation: expect.objectContaining({ status: "verified", contract_id: contractId, quote }),
        }),
      ),
    );

    // The notice period keeps its duration and gains a verified citation of the clause stating it.
    expect(stored.summary.cancellation).toMatchObject({
      notice_period_days: 60,
      notice_period_text: "60 days",
      notice_citation: { status: "verified", contract_id: contractId, quote: STUB_NOTICE_QUOTE },
    });
    expect(stored.summary.cancellation).not.toHaveProperty("notice_evidence");

    // So does renewal, from the clause stating that the agreement renews and for how long.
    expect(stored.summary.renewal).toMatchObject({
      auto_renew: true,
      renewal_period: "12 months",
      renewal_citation: { status: "verified", contract_id: contractId, quote: STUB_RENEWAL_QUOTE },
    });
    expect(stored.summary.renewal).not.toHaveProperty("renewal_evidence");

    const requests = stub.requests();
    expect(requests).toEqual([expect.objectContaining({ model: STUB_MODEL, kind: "analysis", tools: [] })]);
    expect(requests[0]?.question).toContain(text);
  });

  it("reports what it received over HTTP, and refuses a non-streaming request that is not JSON mode", async () => {
    const refused = await fetch(`${stub.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: STUB_MODEL, input: "hi" }),
    });
    expect(refused.status).toBe(400);

    const analysed = await fetch(`${stub.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: STUB_MODEL, input: "Analyse this", text: { format: { type: "json_object" } } }),
    });
    expect(analysed.status).toBe(200);
    const completed = (await analysed.json()) as {
      object: string;
      status: string;
      output: { type: string; content: { type: string; text: string }[] }[];
    };
    expect(completed).toMatchObject({ object: "response", status: "completed", model: STUB_MODEL });
    expect(JSON.parse(completed.output[0]!.content[0]!.text)).toEqual(stubAnalysis());

    const streamed = await fetch(`${stub.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: STUB_MODEL,
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello stub" }] }],
      }),
    });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const events = (await streamed.text())
      .split("\n\n")
      .filter(Boolean)
      .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      ...events.slice(2, -2).map(() => "response.output_text.delta"),
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.length).toBeGreaterThan(5);

    const recorded = await fetch(`${stub.url}/__e2e/requests`);
    expect(await recorded.json()).toEqual({
      data: [
        { model: STUB_MODEL, kind: "analysis", question: "Analyse this", tools: [] },
        { model: STUB_MODEL, kind: "reply", question: "Hello stub", tools: [] },
      ],
    });
  });
});
