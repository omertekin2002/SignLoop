import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type StubModelServer = {
  url: string;
  requests(): StubModelRequest[];
  close(): Promise<void>;
};

/** What the stub keeps of each POST /responses it answered, for the tests' assertions. */
export type StubModelRequest = {
  model: string;
  kind: "title" | "reply" | "analysis";
  /** The text of the last user message in the request; for an analysis, its whole prompt. */
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

/**
 * The contract the analysis fixture describes (e2e/fixtures/e2e-services-agreement.txt). Every
 * quotation in stubAnalysis() appears in it exactly once, word for word, so the app's citation check
 * (lib/source-citations.ts) verifies them when the stub analyses this text.
 */
export const STUB_CONTRACT_FIXTURE = new URL("./fixtures/e2e-services-agreement.txt", import.meta.url);

/** The findings the stub's analysis reports, each with the contract sentence it quotes. */
export const STUB_ANALYSIS_FLAGS = [
  {
    type: "Automatic renewal",
    explanation: "Stub finding: the agreement renews for another year unless notice is given 60 days before the term ends.",
    quote:
      "This agreement renews automatically for successive twelve-month terms unless either party gives 60 days' written notice before the end of the current term.",
  },
  {
    type: "Late payment interest",
    explanation: "Stub finding: unpaid invoices accrue interest at 4% a month, which compounds quickly.",
    quote: "Late payments accrue interest at 4% per month until paid in full.",
  },
  {
    type: "Liability cap",
    explanation: "Stub finding: the Provider's liability is capped at one month of fees.",
    quote: "The Provider's total liability under this agreement is limited to the fees paid in the previous month.",
  },
] as const;

/** The stub's quotation of the clause stating the notice period, with what starts its clock. */
export const STUB_NOTICE_QUOTE =
  "unless either party gives 60 days' written notice before the end of the current term.";

/**
 * The stub's quotation of the clause stating that the agreement renews and for how long. The first
 * finding quotes the whole sentence, which starts with it.
 */
export const STUB_RENEWAL_QUOTE = "This agreement renews automatically for successive twelve-month terms";

/**
 * The stub's quotation of the clause stating the payment amount and frequency. The late-interest
 * finding quotes the next line, which also mentions payments.
 */
export const STUB_PAYMENT_QUOTE =
  "The Client will pay a monthly fee of 1,200 GBP, invoiced on the first day of each month.";

/**
 * The stub's quotation of the clause stating the term: when it starts and how long it lasts. The
 * next two lines, quoted for renewal and the penalty, also speak of the term.
 */
export const STUB_TERM_QUOTE =
  "This agreement starts on the date of the order form and lasts for twelve months.";

/** The stub's one cancellation penalty, as the Penalties box lists it. */
export const STUB_PENALTY = "Early termination fee equal to two months' fees";

/** The stub's quotation of the clause stating that penalty. */
export const STUB_PENALTY_QUOTE =
  "If the Client ends this agreement before the end of the current term, the Client must pay an early termination fee equal to two months' fees.";

/** The stub's one extra fee, as the Fees group lists it. */
export const STUB_FEE = "Late payment fee of 50 GBP";

/** The stub's quotation of the clause stating that fee. */
export const STUB_FEE_QUOTE =
  "A late payment fee of 50 GBP applies to any invoice paid more than 14 days after its due date.";

/** The stub's one obligation, as the Obligations in the contract card lists it. */
export const STUB_OBLIGATION = "Design, host and maintain the Client's website";

/** The stub's quotation of the clause stating that obligation. */
export const STUB_OBLIGATION_QUOTE =
  "The Provider will design, host and maintain the Client's website as described in the order form.";

/**
 * A second obligation the stub states without proposing a quotation, so the page and the brief mark
 * it "No verified quotation" and list it under Before you sign.
 */
export const STUB_UNQUOTED_OBLIGATION = "Pay each invoice within 14 days of its due date";

/** The stub's one key date, as the Key dates card lists it: its exact type and date. */
export const STUB_KEY_DATE = { type: "PRICE_REVIEW", date: "1 April each year" } as const;

/** The analysis's own explanation of where that date comes from (`derived_from`), not contract text. */
export const STUB_KEY_DATE_DERIVED_FROM = "The yearly fee review in the Fees clause";

/** The stub's quotation of the clause stating that key date. */
export const STUB_KEY_DATE_QUOTE = "The Provider may review the monthly fee once a year, on 1 April.";

/** The stub's one question to ask, which the page lists only under Before you sign. */
export const STUB_QUESTION = "Stub question: can the late-payment interest be reduced?";

export const STUB_ANALYSIS_SUMMARY = "Stub analysis: a twelve-month website services agreement.";

/**
 * The fixed analysis, in the JSON shape lib/analysis.ts asks a model for (buildAnalysisPrompt) and
 * parses (AnalysisResultSchema). The fixture is short enough to be one "full" segment.
 */
export function stubAnalysis() {
  return {
    risk_badge: "MEDIUM",
    key_points: [
      "Stub key point: the agreement renews automatically each year.",
      "Stub key point: late payments accrue interest every month.",
    ],
    summary: {
      what_it_is: STUB_ANALYSIS_SUMMARY,
      payments: {
        amount: "1,200 GBP",
        frequency: "Monthly",
        fees: [STUB_FEE],
        fee_evidence: [{ fee: STUB_FEE, quote: STUB_FEE_QUOTE, segment: "full" }],
        payment_evidence: { quote: STUB_PAYMENT_QUOTE, segment: "full" },
      },
      term: {
        start: "The date of the order form",
        end: null,
        minimum_term: "12 months",
        term_evidence: { quote: STUB_TERM_QUOTE, segment: "full" },
      },
      renewal: {
        auto_renew: true,
        renewal_period: "12 months",
        renewal_evidence: { quote: STUB_RENEWAL_QUOTE, segment: "full" },
      },
      cancellation: {
        how: "Written notice before the end of the current term.",
        notice_period_days: 60,
        notice_period_text: "60 days",
        notice_evidence: { quote: STUB_NOTICE_QUOTE, segment: "full" },
        penalties: [STUB_PENALTY],
        penalty_evidence: [{ penalty: STUB_PENALTY, quote: STUB_PENALTY_QUOTE, segment: "full" }],
      },
    },
    red_flags: STUB_ANALYSIS_FLAGS.map(({ type, explanation, quote }, index) => ({
      type,
      severity: 7 - index,
      explanation,
      where: null,
      confidence: 90,
      evidence: { quote, segment: "full" },
    })),
    proposed_jurisdiction: null,
    normal_in_region: [],
    next_actions: {
      questions_to_ask: [STUB_QUESTION],
      email_templates: [],
    },
    key_dates: [{ ...STUB_KEY_DATE, derived_from: STUB_KEY_DATE_DERIVED_FROM }],
    key_date_evidence: [{ ...STUB_KEY_DATE, quote: STUB_KEY_DATE_QUOTE, segment: "full" }],
    obligations: [STUB_OBLIGATION, STUB_UNQUOTED_OBLIGATION],
    obligation_evidence: [
      { obligation: STUB_OBLIGATION, quote: STUB_OBLIGATION_QUOTE, segment: "full" },
    ],
    parties: ["Example Studio Ltd", "The Client"],
    disclaimer: "This is an AI analysis, not legal advice.",
  };
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
// createOpenAI(...).responses(model)). A request that is not streamed and asks for a JSON object,
// as contract analysis does (createResponsesPreferringJson in lib/analysis.ts), gets a completed
// Responses object whose text is stubAnalysis(); any other unstreamed request is refused. GET /__e2e/requests returns what it received, since the
// specs run in worker processes and the stub in the runner's global setup. It listens on
// 127.0.0.1 only and makes no outbound calls.
export async function startStubModelServer(port: number): Promise<StubModelServer> {
  const received: StubModelRequest[] = [];
  let responseCount = 0;
  const record = (request: StubModelRequest) => {
    received.push(request);
    if (received.length > MAX_RECORDED_REQUESTS) received.shift();
  };

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
          if (!isRecord(body)) {
            sendJson(response, 400, { error: { message: "The request body must be a JSON object." } });
            return;
          }
          const model = typeof body.model === "string" ? body.model : "";
          const question = lastUserText(body.input);
          if (body.stream !== true) {
            if (!asksForJsonObject(body.text)) {
              sendJson(response, 400, {
                error: { message: "The stub streams chat replies and answers only JSON analysis requests without streaming." },
              });
              return;
            }
            record({ model, kind: "analysis", question, tools: toolNames(body.tools) });
            responseCount += 1;
            sendJson(
              response,
              200,
              completedResponse(`resp_e2e_${responseCount}`, model || STUB_MODEL, JSON.stringify(stubAnalysis())),
            );
            return;
          }
          // System messages travel in `input` (or, with some settings, in `instructions`).
          const isTitle = JSON.stringify([body.instructions, body.input]).includes(TITLE_PROMPT);
          const kind = isTitle ? "title" : "reply";
          record({ model, kind, question, tools: toolNames(body.tools) });
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

// A finished, non-streamed Responses API object with one assistant message, the shape the openai
// SDK's responses.create returns (it derives output_text from `output`).
function completedResponse(id: string, model: string, text: string) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
}

// `text: { format: { type: "json_object" } }`, the Responses API's JSON mode.
function asksForJsonObject(text: unknown): boolean {
  return isRecord(text) && isRecord(text.format) && text.format.type === "json_object";
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
