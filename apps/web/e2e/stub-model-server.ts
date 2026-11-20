import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type StubModelServer = {
  url: string;
  requests(): StubModelRequest[];
  close(): Promise<void>;
};

/** What the stub keeps of each POST /responses it answered, for the tests' assertions. */
export type StubModelRequest = {
  model: string;
  kind: "title" | "reply";
  /** The text of the last user message in the request. */
  question: string;
  /** Names of the tools the request offered; the stub never calls one. */
  tools: string[];
};

export const STUB_MODEL = "e2e-stub";

// The app names a new saved chat through the same pipeline as the answer (lib/chat-title.ts); its
// system prompt starts with this sentence.
const TITLE_PROMPT = "Create a short, specific title for a conversation";

// Kept bounded so a long run cannot grow the stub's memory without limit.
const MAX_RECORDED_REQUESTS = 200;
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** The fixed reply, with some Markdown, quoting the question so a test can see it arrived. */
export function stubReply(question: string): string {
  return [
    `Stub reply to: ${question}`,
    "",
    "- **Notice period:** sixty days",
    "- **Renewal:** automatic",
    "",
    "This reply comes from the end-to-end stub model.",
  ].join("\n");
}

/** The fixed title for a conversation that starts with `question`, as the app stores it. */
export function stubTitle(question: string): string {
  // The app drops a title's ending punctuation (lib/chat-title.ts).
  return `Stub chat ${question.trim().replace(/[.!?]+$/, "")}`;
}

// A deterministic local stand-in for an OpenAI-compatible endpoint, for the signed-in suite's
// PRIMARY_LLM_BASE_URL. GET /models lists one text model, the shape lib/model-settings.ts reads.
// POST /responses streams a fixed reply as the Responses API's server-sent events, limited to the
// ones @ai-sdk/openai parses into text (packages/chat-engine/src/routing.ts uses
// createOpenAI(...).responses(model)). GET /__e2e/requests returns what it received, since the
// specs run in worker processes and the stub in the runner's global setup. It listens on
// 127.0.0.1 only and makes no outbound calls.
export async function startStubModelServer(port: number): Promise<StubModelServer> {
  const received: StubModelRequest[] = [];
  let responseCount = 0;

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/models") {
      sendJson(response, 200, {
        object: "list",
        // No input_modalities: an unknown id without them is text-only (lib/model-image-input.ts).
        data: [{ id: STUB_MODEL, object: "model", owned_by: "e2e" }],
      });
    } else if (request.method === "POST" && path === "/responses") {
      void readJson(request)
        .then((body) => {
          if (!isRecord(body) || body.stream !== true) {
            sendJson(response, 400, { error: { message: "The stub only streams responses." } });
            return;
          }
          const model = typeof body.model === "string" ? body.model : "";
          const question = lastUserText(body.input);
          // System messages travel in `input` (or, with some settings, in `instructions`).
          const isTitle = JSON.stringify([body.instructions, body.input]).includes(TITLE_PROMPT);
          const kind = isTitle ? "title" : "reply";
          received.push({ model, kind, question, tools: toolNames(body.tools) });
          if (received.length > MAX_RECORDED_REQUESTS) received.shift();
          responseCount += 1;
          // The title request quotes the message as JSON (lib/chat-title.ts).
          const text = kind === "title" ? stubTitle(unquote(question)) : stubReply(question);
          streamResponse(response, `resp_e2e_${responseCount}`, model || STUB_MODEL, text);
        })
        .catch(() => sendJson(response, 400, { error: { message: "Invalid JSON body." } }));
    } else if (request.method === "GET" && path === "/__e2e/requests") {
      sendJson(response, 200, { data: received });
    } else {
      sendJson(response, 404, { error: { message: "Not found." } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    requests: () => [...received],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// The events, in order, of one streamed message: created, the message item, its text in a few
// deltas (so the client sees a stream, not one chunk), the finished item, then completed with usage.
function streamResponse(response: ServerResponse, id: string, model: string, text: string) {
  const itemId = `msg_${id}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const deltas = text.match(/[^\n]*\n?/g)!.filter(Boolean);
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: { id, object: "response", created_at: createdAt, model, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } },
    ...deltas.map((delta) => ({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta })),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message", id: itemId, role: "assistant", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id, object: "response", created_at: createdAt, model, status: "completed",
        incomplete_details: null,
        usage: { input_tokens: 10, output_tokens: deltas.length, total_tokens: 10 + deltas.length },
      },
    },
  ];
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const [sequence, event] of events.entries()) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`);
  }
  response.end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error("Request body too large");
    body += chunk;
  }
  return JSON.parse(body);
}

// Responses API input: a list of items, where a user message's content is a string or a list of
// parts, its text in `input_text` parts.
function lastUserText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const user = input.filter((item) => isRecord(item) && item.role === "user").at(-1);
  if (!isRecord(user)) return "";
  if (typeof user.content === "string") return user.content;
  if (!Array.isArray(user.content)) return "";
  return user.content
    .filter((part) => isRecord(part) && part.type === "input_text" && typeof part.text === "string")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []));
}

function unquote(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : text;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
