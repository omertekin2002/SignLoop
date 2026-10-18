import { createHash } from "node:crypto";

/**
 * Fetch-level replay for the analysis provider. The OpenAI SDK resolves the global `fetch` when
 * each client is constructed, and analysis builds a client per call, so stubbing `fetch` intercepts
 * every provider request without production hooks. Nothing here performs network I/O: any request
 * other than the next recorded interaction is refused and reported.
 *
 * Phase 2 seam: a recording transport (behind SIGNLOOP_EVAL_LIVE=1, with hard call and cost caps)
 * would forward to the live provider and write each exchange as a ReplayInteraction with
 * `expect.fingerprint` set, so replay rejects a recording once the prompt or request changes.
 */
export const REPLAY_ORIGIN = "https://replay.invalid";
export const REPLAY_BASE_URL = `${REPLAY_ORIGIN}/v1`;

export type ReplayUsage = { input_tokens: number; output_tokens: number };

export type ReplayResponse =
  /** A model output object, served as JSON text in a completed Responses API result. */
  | { output: unknown; usage?: ReplayUsage }
  /** Raw model text, for fenced, truncated, or prose output. */
  | { output_text: string; usage?: ReplayUsage }
  /** A raw HTTP exchange, for provider errors or recorded bodies. */
  | { http: { status: number; body: unknown } };

export type ReplayInteraction = {
  expect?: { model?: string; json_mode?: boolean; fingerprint?: string };
  response: ReplayResponse;
};

export type ReplayCall = {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  /** Model text served for this call, when the response carried one. */
  servedText: string | null;
};

export class ReplayViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayViolation";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Identifies what a recorded response answered: model, prompt, and generation options. */
export function requestFingerprint(body: Record<string, unknown>): string {
  const { model, instructions, input, max_output_tokens, text } = body;
  const digest = createHash("sha256")
    .update(
      canonicalJson({ model, instructions, input, max_output_tokens, text }),
    )
    .digest("hex");
  return `sha256:${digest}`;
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function responsesBody(
  text: string,
  model: unknown,
  sequence: number,
  usage?: ReplayUsage,
) {
  return {
    id: `resp_replay_${sequence}`,
    object: "response",
    created_at: 0,
    model: typeof model === "string" ? model : "replay",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "message",
        id: `msg_replay_${sequence}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...(usage
      ? {
          usage: {
            ...usage,
            total_tokens: usage.input_tokens + usage.output_tokens,
          },
        }
      : {}),
  };
}

export function createReplayTransport(
  interactions: readonly ReplayInteraction[],
) {
  const calls: ReplayCall[] = [];
  const violations: string[] = [];
  let served = 0;

  function refuse(reason: string): never {
    violations.push(reason);
    throw new ReplayViolation(reason);
  }

  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const body = parseBody(init?.body);
    const call: ReplayCall = { url, method, body, servedText: null };
    calls.push(call);

    if (method !== "POST" || url !== `${REPLAY_BASE_URL}/responses`) {
      refuse(`Blocked unrecorded request: ${method} ${url}`);
    }
    const interaction = interactions[served];
    if (!interaction) {
      refuse(
        `No recorded response for call ${calls.length} (${interactions.length} recorded)`,
      );
    }
    const { expect, response } = interaction;
    if (expect?.model !== undefined && body?.model !== expect.model) {
      refuse(
        `Call ${calls.length} used model ${String(body?.model)}, recorded ${expect.model}`,
      );
    }
    if (
      expect?.json_mode !== undefined &&
      (body?.text !== undefined) !== expect.json_mode
    ) {
      refuse(`Call ${calls.length} JSON mode differs from the recording`);
    }
    if (
      expect?.fingerprint !== undefined &&
      (!body || requestFingerprint(body) !== expect.fingerprint)
    ) {
      refuse(
        `Call ${calls.length} no longer matches its recording; the prompt or request changed`,
      );
    }
    served += 1;

    if ("http" in response) {
      return Response.json(response.http.body, {
        status: response.http.status,
      });
    }
    const text =
      "output" in response
        ? JSON.stringify(response.output)
        : response.output_text;
    call.servedText = text;
    return Response.json(
      responsesBody(text, body?.model, served, response.usage),
    );
  };

  return {
    fetch,
    calls,
    violations,
    /** Recorded interactions the pipeline did not consume (for example an unused retry). */
    unusedInteractions: () => interactions.length - served,
  };
}

export type ReplayTransport = ReturnType<typeof createReplayTransport>;
