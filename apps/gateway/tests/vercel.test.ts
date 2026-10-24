// The Vercel Function entry (src/vercel.ts, built by scripts/build-vercel.ts) drives the same
// handler as the Bun server. These tests call its exported fetch handler directly, with the real
// configuration and engine; only the network is stubbed, as in contract.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPrimaryModelAvailabilityCache } from "../src/pipeline/provider-models";
import {
  createVercelHandler,
  VERCEL_MAX_DURATION_SECONDS,
  type FetchHandler,
} from "../src/vercel-handler";

const PRIMARY = "https://primary.test/v1";
const ORIGIN = "https://app.test";
const BASE_URL = "https://gateway.test";

const environment = {
  PRIMARY_LLM_BASE_URL: PRIMARY,
  PRIMARY_LLM_API_KEY: "primary-test-key",
  PRIMARY_LLM_MODEL: "gpt-6.1-sol",
  PUBLIC_SERVICE_URL: BASE_URL,
  CORS_ALLOWED_ORIGINS: ORIGIN,
};

const question = [{ role: "user", content: "Say hello." }];

// ---- Responses API stream builders (as in contract.test.ts) -----------------------------------

type SseEvent = Record<string, unknown>;

const encoder = new TextEncoder();
const sseBytes = (events: SseEvent[]) =>
  encoder.encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
const created = (id: string) => ({
  type: "response.created",
  response: { id, model: "gpt-6.1-sol", created_at: 1 },
});
const messageAdded = (id: string) => ({
  type: "response.output_item.added",
  output_index: 0,
  item: { type: "message", id: `${id}-msg` },
});
const delta = (id: string, text: string) => ({
  type: "response.output_text.delta",
  item_id: `${id}-msg`,
  output_index: 0,
  content_index: 0,
  delta: text,
});
const messageDone = (id: string) => ({
  type: "response.output_item.done",
  output_index: 0,
  item: { type: "message", id: `${id}-msg` },
});
const completed = {
  type: "response.completed",
  response: {
    status: "completed",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
};

/** A provider answer whose second half is held back until `gate` resolves. */
function gatedAnswer(id: string, gate: Promise<void>): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        sseBytes([created(id), messageAdded(id), delta(id, "Hello ")]),
      );
      await gate;
      controller.enqueue(
        sseBytes([delta(id, "world."), messageDone(id), completed]),
      );
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

type ProviderStep = (init?: RequestInit) => Response | Promise<Response>;

function installNetwork(steps: ProviderStep[]) {
  const queue = [...steps];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${PRIMARY}/models`)
        return Response.json({
          object: "list",
          data: [{ id: "gpt-6.1-sol", object: "model" }],
        });
      if (url === `${PRIMARY}/responses`) {
        const next = queue.shift();
        if (!next) throw new Error("Unexpected provider step");
        return next(init);
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function providerSignal(network: ReturnType<typeof installNetwork>) {
  const call = network.mock.calls.find(([url]) =>
    String(url).endsWith("/responses"),
  );
  return call?.[1]?.signal ?? undefined;
}

// ---- Handler helpers ------------------------------------------------------------------------

type LogEntry = Record<string, unknown>;

function createHandler(overrides: Record<string, string> = {}): {
  handler: FetchHandler;
  logs: LogEntry[];
} {
  const logs: LogEntry[] = [];
  const handler = createVercelHandler(
    { ...environment, ...overrides },
    {
      log: (entry) => logs.push({ ...entry }),
      requestIdFactory: () => "generated-request",
    },
  );
  return { handler, logs };
}

function chatRequest(
  body: unknown,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Request {
  return new Request(`${BASE_URL}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: JSON.stringify(body),
    signal: init.signal,
  });
}

/** Read NDJSON events from a body as they arrive, until `done` returns true. */
async function readEventsUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string; events: LogEntry[] },
  done: (events: LogEntry[]) => boolean,
): Promise<void> {
  const decoder = new TextDecoder();
  while (!done(state.events)) {
    const { value, done: ended } = await reader.read();
    if (ended) throw new Error("Stream ended early");
    state.buffer += decoder.decode(value, { stream: true });
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? "";
    for (const line of lines) state.events.push(JSON.parse(line) as LogEntry);
  }
}

beforeEach(() => {
  clearPrimaryModelAvailabilityCache();
  // Startup lines (provider order) go to the console once per handler.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPrimaryModelAvailabilityCache();
});

describe("Vercel entry", () => {
  it("serves /healthz without provider work", async () => {
    const network = installNetwork([]);
    const { handler } = createHandler();

    const response = await handler.fetch(new Request(`${BASE_URL}/healthz`));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("generated-request");
    expect(await response.json()).toEqual({
      ok: true,
      service: "signloop-chat-service",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("answers /v1/chat as JSON", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    release();
    installNetwork([() => gatedAnswer("r1", gate)]);
    const { handler, logs } = createHandler();

    const response = await handler.fetch(
      chatRequest(
        { messages: question, stream: false, research: "never" },
        { headers: { "X-Request-ID": "client-1", Origin: ORIGIN } },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("x-request-id")).toBe("client-1");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await response.json()).toMatchObject({
      message: "Hello world.",
      provider: "primary-openai-compatible",
      model: "gpt-6.1-sol",
    });
    expect(logs).toEqual([
      expect.objectContaining({
        requestId: "client-1",
        route: "/v1/chat",
        status: 200,
        streaming: false,
      }),
    ]);
  });

  it("streams NDJSON incrementally rather than buffering the reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    installNetwork([() => gatedAnswer("r1", gate)]);
    const { handler, logs } = createHandler();

    const response = await handler.fetch(
      chatRequest({ messages: question, research: "never" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );

    const reader = response.body!.getReader();
    const state = { buffer: "", events: [] as LogEntry[] };
    // The first delta arrives while the provider is still holding back the rest of its answer.
    await readEventsUntil(reader, state, (events) => events.length > 0);
    expect(state.events).toEqual([{ type: "delta", text: "Hello " }]);
    expect(logs).toEqual([]);

    release();
    await readEventsUntil(reader, state, (events) =>
      events.some((event) => event.type === "done"),
    );
    expect(state.events.map((event) => event.type)).toEqual([
      "delta",
      "delta",
      "done",
    ]);
    expect(state.events.at(-1)).toMatchObject({ message: "Hello world." });
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() =>
      expect(logs).toEqual([
        expect.objectContaining({ status: 200, streaming: true }),
      ]),
    );
  });

  it("answers CORS preflight for allowlisted origins only", async () => {
    const { handler } = createHandler();
    const preflight = (origin: string) =>
      handler.fetch(
        new Request(`${BASE_URL}/v1/chat`, {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
        }),
      );

    const allowed = await preflight(ORIGIN);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(allowed.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(allowed.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, X-Request-ID",
    );

    const rejected = await preflight("https://other.test");
    expect(rejected.status).toBe(404);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns 404 for unknown paths and methods", async () => {
    const network = installNetwork([]);
    const { handler } = createHandler();

    for (const request of [
      new Request(`${BASE_URL}/`),
      new Request(`${BASE_URL}/index`),
      new Request(`${BASE_URL}/v1/other`, { method: "POST" }),
      new Request(`${BASE_URL}/v1/chat`),
    ]) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Not found",
        code: "invalid_request",
      });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("aborts the provider call when a JSON client disconnects", async () => {
    const network = installNetwork([
      hangUntilAborted,
      () => gatedAnswer("r2", Promise.resolve()),
    ]);
    // One slot: the follow-up request only succeeds if the aborted turn released it.
    const { handler, logs } = createHandler({ MAX_CONCURRENT_REQUESTS: "1" });
    const client = new AbortController();

    const pending = handler.fetch(
      chatRequest(
        { messages: question, stream: false, research: "never" },
        { signal: client.signal },
      ),
    );
    await vi.waitFor(() => expect(providerSignal(network)).toBeDefined());
    expect(providerSignal(network)?.aborted).toBe(false);

    client.abort();
    await pending;
    expect(providerSignal(network)?.aborted).toBe(true);
    expect(logs).toHaveLength(1);

    const next = await handler.fetch(
      chatRequest({ messages: question, stream: false, research: "never" }),
    );
    expect(next.status).toBe(200);
  });

  it("aborts the provider call when a streaming client disconnects", async () => {
    const network = installNetwork([hangUntilAborted]);
    const { handler, logs } = createHandler();
    const client = new AbortController();

    const response = await handler.fetch(
      chatRequest(
        { messages: question, research: "never" },
        { signal: client.signal },
      ),
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(providerSignal(network)).toBeDefined());

    client.abort();
    await vi.waitFor(() => expect(providerSignal(network)?.aborted).toBe(true));
    // A cancelled stream sends no terminal event and records the cancellation.
    expect(await response.text()).toBe("");
    await vi.waitFor(() =>
      expect(logs).toEqual([
        expect.objectContaining({ status: 200, streamOutcome: "cancelled" }),
      ]),
    );
  });

  it("aborts the provider call when the response body is cancelled", async () => {
    const network = installNetwork([hangUntilAborted]);
    const { handler } = createHandler();

    const response = await handler.fetch(
      chatRequest({ messages: question, research: "never" }),
    );
    await vi.waitFor(() => expect(providerSignal(network)).toBeDefined());

    await response.body!.cancel(new Error("client went away"));
    await vi.waitFor(() => expect(providerSignal(network)?.aborted).toBe(true));
  });

  it("answers every request with 503 when the configuration is invalid", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs: LogEntry[] = [];
    const handler = createVercelHandler(
      { PRIMARY_LLM_BASE_URL: PRIMARY, PRIMARY_LLM_API_KEY: "secret value" },
      { log: (entry) => logs.push({ ...entry }) },
    );

    expect(errors).toHaveBeenCalledTimes(1);
    const logged = String(errors.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({
      level: "error",
      event: "config_invalid",
      message: "PRIMARY_LLM_API_KEY must not contain whitespace",
    });
    expect(logged).not.toContain("secret");

    for (const request of [
      new Request(`${BASE_URL}/healthz`),
      chatRequest(
        { messages: question },
        { headers: { "X-Request-ID": "req-9" } },
      ),
    ]) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "Chat service is not configured.",
        code: "service_unavailable",
      });
    }
    expect(logs).toEqual([
      expect.objectContaining({ route: "/healthz", status: 503 }),
      expect.objectContaining({
        requestId: "req-9",
        route: "/v1/chat",
        status: 503,
        errorClass: "ConfigurationError",
      }),
    ]);
  });

  it("warns when the request deadline cannot fit in the function's maximum duration", () => {
    const warnings = vi.mocked(console.warn);
    createHandler({
      REQUEST_TIMEOUT_MS: String(VERCEL_MAX_DURATION_SECONDS * 1000),
    });
    expect(
      warnings.mock.calls.map(([line]) => JSON.parse(String(line))),
    ).toContainEqual(
      expect.objectContaining({
        event: "request_timeout_exceeds_max_duration",
      }),
    );
  });

  it("exports a fetch handler configured from the environment at module load", async () => {
    for (const name of [
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
      "WEB_SEARCH_PROVIDER",
      "ENABLE_IMAGE_GENERATION",
      "MAX_CONCURRENT_REQUESTS",
      "REQUEST_TIMEOUT_MS",
    ])
      vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);
    vi.resetModules();

    const entry = (await import("../src/vercel")).default;
    const response = await entry.fetch(new Request(`${BASE_URL}/healthz`));

    expect(response.status).toBe(200);
    expect(
      vi
        .mocked(console.log)
        .mock.calls.map(([line]) => JSON.parse(String(line))),
    ).toContainEqual({
      level: "info",
      event: "generation_providers",
      providers: ["primary-openai-compatible:gpt-6.1-sol"],
    });
  });
});
