// Golden contract for the public HTTP API. Each scenario drives the real handler, configuration and
// chat engine; only the network is stubbed. The fixtures were recorded from the standalone
// SLgateway service before it moved onto @repo/chat-engine, so any change to routes, status codes,
// headers, JSON bodies, NDJSON events or the access/provider log entries fails here.
//
// After an intentional API change, review the diff and rerun with `bun run test -u` to rewrite
// the fixtures. External callers (such as the otekin CLI) depend on this shape.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { InferenceSemaphore } from "../src/concurrency";
import { loadServiceConfig } from "../src/config";
import { createRequestHandler } from "../src/handler";
import { clearPrimaryModelAvailabilityCache } from "../src/pipeline/provider-models";

const PRIMARY = "https://primary.test/v1";
const ORIGIN = "https://app.test";
const FIXTURES = "./fixtures/contract";

const baseEnvironment = {
  PRIMARY_LLM_BASE_URL: PRIMARY,
  PRIMARY_LLM_API_KEY: "primary-test-key",
  PRIMARY_LLM_MODEL: "gpt-6.1-sol",
  BRAVE_SEARCH_API_KEY: "brave-test-key",
  PUBLIC_SERVICE_URL: "https://gateway.test",
  CORS_ALLOWED_ORIGINS: ORIGIN,
  ENABLE_IMAGE_GENERATION: "true",
  IMAGE_GENERATION_MODEL: "gpt-image-2.5-sunburst",
};

// ---- Responses API stream builders --------------------------------------------------------

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const created = (id: string) => ({
  type: "response.created",
  response: { id, model: "gpt-6.1-sol", created_at: 1 },
});
const completed = {
  type: "response.completed",
  response: {
    status: "completed",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
};
function answer(id: string, deltas: string[]): () => Response {
  return () =>
    sse([
      created(id),
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: `${id}-msg` },
      },
      ...deltas.map((delta) => ({
        type: "response.output_text.delta",
        item_id: `${id}-msg`,
        output_index: 0,
        content_index: 0,
        delta,
      })),
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: `${id}-msg` },
      },
      completed,
    ]);
}
function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): () => Response {
  const call = {
    type: "function_call",
    id: `${id}-fc`,
    call_id: `${id}-call`,
    name,
    arguments: JSON.stringify(input),
  };
  return () =>
    sse([
      created(id),
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: call.id,
        output_index: 0,
        delta: call.arguments,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...call, status: "completed" },
      },
      completed,
    ]);
}

// ---- Network stub ---------------------------------------------------------------------------

type ProviderStep = () => Response | Promise<Response>;

function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function installNetwork(
  steps: ProviderStep[],
  options: { models?: string[]; hang?: boolean } = {},
) {
  const queue = [...steps];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${PRIMARY}/models`)
        return Response.json({
          object: "list",
          data: (options.models ?? ["gpt-6.1-sol"]).map((id) => ({
            id,
            object: "model",
          })),
        });
      if (url === `${PRIMARY}/responses`) {
        if (options.hang) return hangUntilAborted(init);
        const next = queue.shift();
        if (!next) throw new Error("Unexpected provider step");
        return next();
      }
      if (url === `${PRIMARY}/images/generations`)
        return Response.json({
          created: 1,
          data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" }],
        });
      if (url.startsWith("https://api.search.brave.com/res/v1/web/search"))
        return Response.json({
          web: {
            results: [
              {
                title: "Central bank rates",
                url: "https://rates.example/2026",
                description: "The base rate is 4.25% in October 2026.",
              },
              {
                title: "Rate history",
                url: "https://history.example/rates",
                description: "Historical base rates.",
              },
            ],
          },
        });
      if (url === "https://r.jina.ai/https://rates.example/2026")
        return Response.json({
          data: {
            title: "Central bank rates",
            content: "The central bank set the base rate at 4.25% on 1 October 2026.",
          },
        });
      if (url === "https://r.jina.ai/https://history.example/rates")
        return Response.json({
          data: {
            title: "Rate history",
            content: "The base rate was 4.50% in 2025 and 4.25% in 2026.",
          },
        });
      throw new Error(`Unexpected outbound request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---- Handler and capture helpers ------------------------------------------------------------

type LogEntry = Record<string, unknown>;

function createHandler(
  environment: Record<string, string> = {},
  semaphore?: InferenceSemaphore,
) {
  const logs: LogEntry[] = [];
  let sequence = 0;
  const handler = createRequestHandler({
    config: loadServiceConfig({ ...baseEnvironment, ...environment }),
    log: (entry) => logs.push({ ...entry }),
    requestIdFactory: () => `generated-request-${++sequence}`,
    ...(semaphore ? { semaphore } : {}),
  });
  return { handler, logs };
}

function chatRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://gateway.test/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function headerRecord(response: Response): Record<string, string> {
  return Object.fromEntries(
    [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Logs are pinned too, with only the wall-clock duration normalized. */
function normalizedLogs(logs: LogEntry[]): LogEntry[] {
  return logs.map((entry) =>
    "durationMs" in entry ? { ...entry, durationMs: "<duration>" } : entry,
  );
}

async function captureJson(response: Response, logs: LogEntry[] = []) {
  const text = await response.text();
  return {
    status: response.status,
    headers: headerRecord(response),
    body: text ? JSON.parse(text) : null,
    logs: normalizedLogs(logs),
  };
}

async function captureNdjson(response: Response, logs: LogEntry[]) {
  const text = await response.text();
  // Every event is one complete JSON line; exactly one terminal event ends the stream.
  expect(text.endsWith("\n")).toBe(true);
  const events = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  expect(
    events.filter((event) => event.type === "done" || event.type === "error"),
  ).toHaveLength(1);
  expect(["done", "error"]).toContain(events.at(-1)?.type);
  // The stream releases its resources and logs after the terminal event.
  await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0));
  return {
    status: response.status,
    headers: headerRecord(response),
    events,
    logs: normalizedLogs(logs),
  };
}

async function expectGolden(name: string, value: unknown): Promise<void> {
  await expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(
    `${FIXTURES}/${name}.json`,
  );
}

beforeEach(() => {
  clearPrimaryModelAvailabilityCache();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-24T12:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearPrimaryModelAvailabilityCache();
});

// ---- Scenarios ------------------------------------------------------------------------------

const question = [{ role: "user", content: "What is the base rate?" }];

it("serves /healthz and rejects unknown routes", async () => {
  const { handler } = createHandler();
  const network = installNetwork([]);
  const health = await handler(new Request("http://gateway.test/healthz"));
  const unknownRoute = await handler(
    new Request("http://gateway.test/v1/other", { method: "POST" }),
  );
  const wrongMethod = await handler(new Request("http://gateway.test/v1/chat"));
  await expectGolden("health-and-routing", {
    health: await captureJson(health),
    unknownRoute: await captureJson(unknownRoute),
    wrongMethod: await captureJson(wrongMethod),
  });
  expect(network).not.toHaveBeenCalled();
});

it("answers CORS preflight only for allowlisted origins", async () => {
  const { handler } = createHandler();
  const preflight = (origin: string) =>
    handler(
      new Request("http://gateway.test/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "X-Request-ID": "preflight-1",
        },
      }),
    );
  await expectGolden("cors-preflight", {
    allowed: await captureJson(await preflight(ORIGIN)),
    rejected: await captureJson(await preflight("https://other.test")),
  });
});

it("returns stable validation errors before any provider work", async () => {
  const network = installNetwork([]);
  const { handler } = createHandler();
  const oversizedHistory = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "x".repeat(3_999),
  }));
  const cases: Record<string, Request> = {
    wrongContentType: new Request("http://gateway.test/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ messages: question }),
    }),
    declaredBodyTooLarge: new Request("http://gateway.test/v1/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(128 * 1024 + 1),
      },
      body: "{}",
    }),
    actualBodyTooLarge: chatRequest({
      messages: question,
      padding: "x".repeat(128 * 1024),
    }),
    invalidJson: chatRequest("{not json"),
    bodyNotObject: chatRequest([]),
    messagesNotArray: chatRequest({ messages: "hello" }),
    tooManyMessages: chatRequest({
      messages: Array.from({ length: 31 }, () => question[0]),
    }),
    invalidRole: chatRequest({ messages: [{ role: "system", content: "x" }] }),
    messageTooLong: chatRequest({
      messages: [{ role: "user", content: "x".repeat(4_001) }],
    }),
    emptyMessage: chatRequest({ messages: [{ role: "user", content: "  " }] }),
    historyTooLarge: chatRequest({
      messages: [...oversizedHistory, { role: "user", content: "next" }],
    }),
    noMessages: chatRequest({ messages: [] }),
    finalAssistant: chatRequest({
      messages: [...question, { role: "assistant", content: "Answer" }],
    }),
    modelSelection: chatRequest({ messages: question, model: "other" }),
    providerSelection: chatRequest({ messages: question, provider: "x" }),
    baseUrlSelection: chatRequest({ messages: question, baseURL: "x" }),
    streamNotBoolean: chatRequest({ messages: question, stream: "yes" }),
    researchInvalid: chatRequest({ messages: question, research: "sometimes" }),
  };
  const captured: Record<string, unknown> = {};
  for (const [name, request] of Object.entries(cases))
    captured[name] = await captureJson(await handler(request));
  await expectGolden("validation-errors", captured);
  expect(network).not.toHaveBeenCalled();
});

it("returns service_busy while every inference slot is taken", async () => {
  const semaphore = new InferenceSemaphore(1);
  const release = semaphore.tryAcquire();
  const { handler, logs } = createHandler({}, semaphore);
  const response = await handler(
    chatRequest({ messages: question }, { "X-Request-ID": "busy-1" }),
  );
  await expectGolden("service-busy", await captureJson(response, logs));
  release?.();
});

it("returns a plain non-streaming answer with metadata and CORS", async () => {
  installNetwork([answer("r1", ["The base rate ", "is 4.25%."])]);
  const { handler, logs } = createHandler();
  const response = await handler(
    chatRequest(
      { messages: question, stream: false },
      { Origin: ORIGIN, "X-Request-ID": "client-request-1" },
    ),
  );
  await expectGolden("json-plain", await captureJson(response, logs));
});

it("streams a plain answer as NDJSON by default", async () => {
  installNetwork([answer("r1", ["The base rate ", "is 4.25%."])]);
  const { handler, logs } = createHandler();
  const response = await handler(
    chatRequest({ messages: question }, { "X-Request-ID": "invalid id!" }),
  );
  await expectGolden("ndjson-plain", await captureNdjson(response, logs));
});

it("answers without tools when research is never", async () => {
  const network = installNetwork([answer("r1", ["From memory: 4.25%."])]);
  const { handler, logs } = createHandler();
  const response = await handler(
    chatRequest({ messages: question, stream: false, research: "never" }),
  );
  await expectGolden("json-research-never", await captureJson(response, logs));
  const providerRequest = JSON.parse(
    String(
      network.mock.calls.find(([url]) => String(url).endsWith("/responses"))?.[1]
        ?.body,
    ),
  );
  expect(providerRequest.tools ?? []).toEqual([]);
});

const researchSteps = () => [
  toolCall("r1", "search_web", { query: "base rate October 2026" }),
  toolCall("r2", "read_url", { url: "https://rates.example/2026" }),
  answer("r3", ["The base rate is 4.25% [1]."]),
];

it("returns a researched non-streaming answer with sources and replay state", async () => {
  installNetwork(researchSteps());
  const { handler, logs } = createHandler();
  const response = await handler(
    chatRequest({ messages: question, stream: false, research: "auto" }),
  );
  await expectGolden("json-research", await captureJson(response, logs));
});

it("streams tool activity, deltas and the canonical reply for research", async () => {
  installNetwork(researchSteps());
  const { handler, logs } = createHandler();
  const response = await handler(chatRequest({ messages: question }));
  await expectGolden("ndjson-research", await captureNdjson(response, logs));
});

it("holds back strict-research deltas until fresh evidence is confirmed", async () => {
  installNetwork(researchSteps());
  const { handler, logs } = createHandler();
  const response = await handler(
    chatRequest({ messages: question, research: "always" }),
  );
  await expectGolden(
    "ndjson-research-always",
    await captureNdjson(response, logs),
  );
});

it("keeps citation numbers stable when a follow-up reads another page", async () => {
  installNetwork(researchSteps());
  const first = createHandler();
  const firstReply = await (
    await first.handler(chatRequest({ messages: question, stream: false }))
  ).json();

  installNetwork([
    toolCall("r4", "read_url", { url: "https://history.example/rates" }),
    answer("r5", ["It was 4.50% in 2025 [2], now 4.25% [1]."]),
  ]);
  const { handler, logs } = createHandler();
  const response = await handler(
    chatRequest({
      stream: false,
      messages: [
        ...question,
        {
          role: "assistant",
          content: firstReply.message,
          agentMessages: firstReply.agentMessages,
          webSources: firstReply.webSources,
        },
        { role: "user", content: "And last year?" },
      ],
    }),
  );
  await expectGolden("json-follow-up", await captureJson(response, logs));
});

it("inserts a generated image when discovery advertises the image model", async () => {
  installNetwork(
    [
      toolCall("r1", "generate_image", { prompt: "A chart of base rates" }),
      answer("r2", ["Here is a chart of the base rate."]),
    ],
    { models: ["gpt-6.1-sol", "gpt-image-2.5-sunburst"] },
  );
  const { handler, logs } = createHandler();
  const response = await handler(
    chatRequest({
      messages: [{ role: "user", content: "Draw a chart of base rates" }],
      stream: false,
    }),
  );
  await expectGolden("json-image", await captureJson(response, logs));
});

it("reports research_unavailable for an unresearched strict answer", async () => {
  const steps = () => [answer("r1", ["Unverified 4.25%."])];
  installNetwork(steps());
  const json = createHandler();
  const jsonResponse = await json.handler(
    chatRequest({ messages: question, stream: false, research: "always" }),
  );
  const jsonCapture = await captureJson(jsonResponse, json.logs);

  installNetwork(steps());
  const streamed = createHandler();
  const streamResponse = await streamed.handler(
    chatRequest({ messages: question, research: "always" }),
  );
  await expectGolden("research-unavailable", {
    json: jsonCapture,
    ndjson: await captureNdjson(streamResponse, streamed.logs),
  });
});

it("reports generation_unavailable when every provider fails", async () => {
  const failure = () =>
    Response.json(
      { error: { message: "upstream secret detail", code: "server_error" } },
      { status: 500, headers: { "x-request-id": "upstream-req-1" } },
    );
  installNetwork([failure]);
  const json = createHandler();
  const jsonCapture = await captureJson(
    await json.handler(chatRequest({ messages: question, stream: false })),
    json.logs,
  );

  installNetwork([failure]);
  const streamed = createHandler();
  const streamCapture = await captureNdjson(
    await streamed.handler(chatRequest({ messages: question })),
    streamed.logs,
  );
  expect(JSON.stringify([jsonCapture, streamCapture])).not.toContain(
    "upstream secret detail",
  );
  await expectGolden("generation-unavailable", {
    json: jsonCapture,
    ndjson: streamCapture,
  });
});

it("falls back to the next provider when the primary model is not advertised", async () => {
  const { handler, logs } = createHandler({
    OPENROUTER_API_KEY: "openrouter-test-key",
    OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
  });
  // Discovery excludes the primary, so the only generation call goes to OpenRouter.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${PRIMARY}/models`)
        return Response.json({ data: [{ id: "some-other-model" }] });
      if (url === "https://openrouter.test/api/v1/responses")
        return answer("o1", ["OpenRouter answer."])();
      throw new Error(`Unexpected outbound request: ${url}`);
    }),
  );
  const response = await handler(
    chatRequest({ messages: question, stream: false }),
  );
  await expectGolden("json-primary-unavailable", await captureJson(response, logs));
});

it("reports request_timeout when the service deadline passes", async () => {
  vi.useRealTimers();
  installNetwork([], { hang: true });
  const json = createHandler({ REQUEST_TIMEOUT_MS: "100" });
  const jsonCapture = await captureJson(
    await json.handler(chatRequest({ messages: question, stream: false })),
    json.logs,
  );

  installNetwork([], { hang: true });
  const streamed = createHandler({ REQUEST_TIMEOUT_MS: "100" });
  const streamCapture = await captureNdjson(
    await streamed.handler(chatRequest({ messages: question })),
    streamed.logs,
  );
  await expectGolden("request-timeout", {
    json: jsonCapture,
    ndjson: streamCapture,
  });
});
