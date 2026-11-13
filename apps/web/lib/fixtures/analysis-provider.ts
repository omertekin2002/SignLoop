import { vi } from "vitest";
import type { ContractSegment } from "../source-citations";

// A provider double for contract analysis: section and merge answers in the Responses API's
// shape, served through a stubbed global fetch. Shared by the analysis and analyze-route tests.

// Numbered clauses of about 88 code points; the emoji make code point and UTF-16 offsets differ.
export const clause = (number: number) =>
  `${number}. Records. Each party keeps accurate records of its own work under this agreement 😀.\n`;
export const contractOf = (
  clauses: number,
  extra: Record<number, string> = {},
) =>
  Array.from(
    { length: clauses },
    (_, index) => extra[index + 1] ?? clause(index + 1),
  ).join("");

type Flag = {
  type: string;
  explanation: string;
  quote?: string;
  severity?: number;
};

export function sectionOutput(
  segment: ContractSegment,
  options: {
    flags?: Flag[];
    questions?: string[];
    badge?: "LOW" | "MEDIUM" | "HIGH";
    autoRenew?: boolean | null;
    noticeDays?: number | null;
    noticeText?: string | null;
    jurisdiction?: string;
  } = {},
) {
  return {
    risk_badge: options.badge ?? "LOW",
    key_points: [`Covers ${segment.label}.`],
    summary: {
      what_it_is: "A services agreement.",
      payments: { amount: null, frequency: null, fees: [] },
      term: { start: null, end: null, minimum_term: null },
      renewal: { auto_renew: options.autoRenew ?? null, renewal_period: null },
      cancellation: {
        how: "Not specified",
        notice_period_days: options.noticeDays ?? null,
        notice_period_text: options.noticeText ?? null,
        penalties: [],
      },
    },
    red_flags: (options.flags ?? []).map((flag) => ({
      type: flag.type,
      severity: flag.severity ?? 6,
      explanation: flag.explanation,
      where: null,
      confidence: 80,
      evidence: flag.quote
        ? { quote: flag.quote, segment: segment.label }
        : null,
    })),
    proposed_jurisdiction: options.jurisdiction
      ? {
          jurisdiction: "State of Delaware",
          evidence: { quote: options.jurisdiction, segment: segment.label },
        }
      : null,
    normal_in_region: [],
    next_actions: {
      questions_to_ask: options.questions ?? [],
      email_templates: [],
    },
    key_dates: [],
    obligations: [],
    parties: ["Provider", "Customer"],
    disclaimer: "This is an AI analysis, not legal advice.",
  };
}

export function mergeOutput(overrides: Record<string, unknown> = {}) {
  return {
    risk_badge: "HIGH",
    key_points: ["Renews automatically each year."],
    summary: {
      what_it_is: "A services agreement.",
      payments: { amount: null, frequency: null, fees: [] },
      term: { start: null, end: null, minimum_term: null },
      renewal: { auto_renew: true, renewal_period: "1 year" },
      cancellation: {
        how: "Written notice",
        notice_period_days: 60,
        notice_period_text: "60 days",
        penalties: [],
      },
    },
    red_flag_ids: [],
    normal_in_region: [],
    next_actions: { questions_to_ask: [], email_templates: [] },
    key_dates: [],
    obligations: [],
    parties: ["Provider", "Customer"],
    disclaimer: "This is an AI analysis, not legal advice.",
    ...overrides,
  };
}

export function completed(output: unknown, usage = { input: 100, output: 10 }) {
  return Response.json({
    id: "resp_test",
    object: "response",
    status: "completed",
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(output),
            annotations: [],
          },
        ],
      },
    ],
  });
}

export type Call = {
  section: number | "merge";
  input: string;
  signal?: AbortSignal;
};
export type Reply = (call: Call) => Response | Promise<Response>;

/** A provider double that answers section and merge calls and records how many ran at once. */
export function provider(segments: readonly ContractSegment[], reply: Reply) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const input = String(JSON.parse(String(init?.body)).input);
    const match = input.match(/This request contains section (\d+) of/);
    const call: Call = {
      section: match ? Number(match[1]) : "merge",
      input,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // Yield so concurrent calls overlap, as real requests would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await reply(call);
    } finally {
      inFlight -= 1;
    }
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    maxInFlight: () => maxInFlight,
    sectionCalls: () => calls.filter((call) => call.section !== "merge"),
    mergeCalls: () => calls.filter((call) => call.section === "merge"),
    segment: (call: Call) => segments[(call.section as number) - 1]!,
  };
}

/** Never answers; rejects once the request is aborted, as the SDK's fetch would. */
export const hang: Reply = ({ signal }) =>
  new Promise((_resolve, reject) => {
    const abort = () =>
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort);
  });

export const failure = () =>
  Response.json(
    { error: { message: "upstream unavailable" } },
    { status: 500 },
  );
