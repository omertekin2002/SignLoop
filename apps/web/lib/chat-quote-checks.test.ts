import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkQuotations,
  extractQuotations,
  MAX_QUOTE_CHECKS,
  parseChatQuoteChecks,
} from "./chat-quote-checks";
import { contractSourceRevision } from "./analysis-sources";
import { MAX_EVIDENCE_QUOTE } from "./source-citations";
import {
  STUB_CONTRACT_FIXTURE,
  STUB_FOCUSED_FOUND_QUOTE,
  STUB_FOCUSED_INVENTED_QUOTE,
  stubFocusedReply,
} from "../e2e/stub-model-server";

const CONTRACT = readFileSync(STUB_CONTRACT_FIXTURE, "utf8");
const OTHER_CONTRACT = [
  "OFFICE LEASE",
  "1. Rent",
  "The Tenant will pay rent of 3,000 EUR on the first working day of each quarter.",
  "2. Break clause",
  "Either party may end this lease on six months' written notice after the second year.",
].join("\n");

describe("extractQuotations", () => {
  it("takes a blockquote passage, joining its consecutive lines", () => {
    expect(
      extractQuotations(
        [
          "Clause 3 says:",
          "",
          "> This agreement renews automatically for successive",
          "> twelve-month terms unless either party gives notice.",
          "",
          "So it renews.",
        ].join("\n"),
      ),
    ).toEqual([
      "This agreement renews automatically for successive twelve-month terms unless either party gives notice",
    ]);
  });

  it("splits a blockquote into its paragraphs and list items, and skips an attribution line", () => {
    expect(
      extractQuotations(
        [
          "> Late payments accrue interest at 4% per month until paid in full.",
          ">",
          "> - The Provider may review the monthly fee once a year",
          "> - A late payment fee of 50 GBP applies",
          ">",
          "> — Clause 2, Fees",
        ].join("\n"),
      ),
    ).toEqual([
      "Late payments accrue interest at 4% per month until paid in full",
      "The Provider may review the monthly fee once a year",
      "A late payment fee of 50 GBP applies",
    ]);
  });

  it("takes inline straight and curly quotations of at least six words, skipping short phrases and scare quotes", () => {
    expect(
      extractQuotations(
        'The "Provider" is "responsible" for hosting. It says "the Provider will design, host and maintain the website" and “Late payments accrue interest at 4% per month.”',
      ),
    ).toEqual([
      "the Provider will design, host and maintain the website",
      "Late payments accrue interest at 4% per month",
    ]);
  });

  it("uses the inline quotations in a blockquote that holds them, rather than the whole paragraph", () => {
    expect(
      extractQuotations(
        '> **Clause 4** says "the Provider\'s total liability under this agreement is limited".',
      ),
    ).toEqual(["the Provider's total liability under this agreement is limited"]);
    expect(
      extractQuotations("> “This agreement is governed by the laws of England and Wales.”"),
    ).toEqual(["This agreement is governed by the laws of England and Wales"]);
  });

  it("ignores code spans and fenced code blocks, including blockquote lines inside them", () => {
    expect(
      extractQuotations(
        [
          'Run `grep "Either party may end this lease on notice" lease.txt` to search.',
          "```",
          "> Either party may end this lease on six months' notice",
          'const text = "Either party may end this lease on six months notice";',
          "```",
          "~~~text",
          'echo "The Tenant will pay rent on the first day"',
          "~~~",
          "> Real quotation: the Tenant will pay rent quarterly",
          "> `inline code` stays out",
        ].join("\n"),
      ),
    ).toEqual(["Real quotation: the Tenant will pay rent quarterly stays out"]);
  });

  it("does not join an inline quotation across a blank line", () => {
    expect(
      extractQuotations('He said "one two three\n\nfour five six seven" here.'),
    ).toEqual([]);
  });

  it("trims a leading or trailing ellipsis and trailing punctuation written inside the marks", () => {
    expect(
      extractQuotations('It says "…the Client must pay an early termination fee…" and "renews automatically for successive twelve-month terms,"'),
    ).toEqual([
      "the Client must pay an early termination fee",
      "renews automatically for successive twelve-month terms",
    ]);
  });

  it("drops repeats, including ones differing only in whitespace or quotation marks", () => {
    expect(
      extractQuotations(
        [
          "> The Provider's total liability is limited to fees.",
          "",
          'As quoted, "The Provider’s total  liability is limited to fees".',
        ].join("\n"),
      ),
    ).toEqual(["The Provider's total liability is limited to fees"]);
  });

  it("caps the count and skips a quotation longer than the analysis limit", () => {
    const many = Array.from(
      { length: MAX_QUOTE_CHECKS + 5 },
      (_, index) => `> Quotation number ${index} of the many passages`,
    ).join("\n>\n");
    const quotations = extractQuotations(many);
    expect(quotations).toHaveLength(MAX_QUOTE_CHECKS);
    expect(quotations[0]).toBe("Quotation number 0 of the many passages");

    const long = `${"word ".repeat(MAX_EVIDENCE_QUOTE / 5)}end`;
    expect(extractQuotations(`> ${long}\n\nAnd "a short quotation of six words".`)).toEqual([
      "a short quotation of six words",
    ]);
  });

  it("finds nothing in a reply without quotations", () => {
    expect(extractQuotations("The notice period is **sixty days**.\n\n- Renewal: automatic")).toEqual([]);
  });
});

describe("checkQuotations", () => {
  it("marks a verbatim quotation found, including one spanning a line break in the contract", () => {
    expect(
      checkQuotations(
        [
          "Late payments accrue interest at 4% per month until paid in full",
          // Two lines of the Fees clause, quoted as one sentence.
          "invoiced on the first day of each month. Late payments accrue interest",
        ],
        CONTRACT,
      ),
    ).toEqual([
      { quote: "Late payments accrue interest at 4% per month until paid in full", status: "found" },
      { quote: "invoiced on the first day of each month. Late payments accrue interest", status: "found" },
    ]);
  });

  it("treats curly and straight quotation marks and apostrophes, and whitespace runs, as equal on both sides", () => {
    expect(
      checkQuotations(
        [
          "unless either party gives 60 days’ written notice",
          "between Example Studio Ltd (the “Provider”)",
          "The  Provider’s total\tliability",
        ],
        CONTRACT,
      ).map((check) => check.status),
    ).toEqual(["found", "found", "found"]);
  });

  it("still counts a quotation that appears more than once as found", () => {
    expect(CONTRACT.split("this agreement").length).toBeGreaterThan(2);
    expect(checkQuotations(["this agreement"], CONTRACT)[0]?.status).toBe("found");
  });

  it("marks a paraphrase, a one-word change and a quotation from a different contract not found", () => {
    expect(
      checkQuotations(
        [
          "Late payments are charged interest of 4% each month until fully paid",
          "Late payments accrue interest at 5% per month until paid in full",
          "Either party may end this lease on six months' written notice",
        ],
        CONTRACT,
      ).map((check) => check.status),
    ).toEqual(["not_found", "not_found", "not_found"]);
    expect(
      checkQuotations(["Either party may end this lease on six months' written notice"], OTHER_CONTRACT)[0]
        ?.status,
    ).toBe("found");
  });

  it("forgives nothing fuzzier: case, hyphens and punctuation must match", () => {
    expect(
      checkQuotations(
        [
          "late payments accrue interest at 4% per month",
          "successive twelve month terms",
          "The Client will pay a monthly fee of 1200 GBP",
        ],
        CONTRACT,
      ).map((check) => check.status),
    ).toEqual(["not_found", "not_found", "not_found"]);
  });

  it("checks the e2e stub's focused reply as one found and one not-found quotation", () => {
    expect(checkQuotations(extractQuotations(stubFocusedReply("Question?")), CONTRACT)).toEqual([
      { quote: STUB_FOCUSED_FOUND_QUOTE, status: "found" },
      { quote: STUB_FOCUSED_INVENTED_QUOTE, status: "not_found" },
    ]);
  });
});

describe("parseChatQuoteChecks", () => {
  const stored = {
    contractId: "33333333-3333-4333-8333-333333333333",
    revision: contractSourceRevision(CONTRACT),
    checks: [
      { quote: "Late payments accrue interest", status: "found" },
      { quote: "Invented", status: "not_found" },
    ],
  };

  it("keeps well-formed checks and drops malformed rows", () => {
    expect(parseChatQuoteChecks(stored)).toEqual(stored);
    expect(
      parseChatQuoteChecks({
        ...stored,
        checks: [...stored.checks, { quote: "", status: "found" }, { quote: "x", status: "maybe" }, null],
      }),
    ).toEqual(stored);
  });

  it("is null for missing, malformed or empty checks", () => {
    expect(parseChatQuoteChecks(undefined)).toBeNull();
    expect(parseChatQuoteChecks({ ...stored, contractId: "not-a-uuid" })).toBeNull();
    expect(parseChatQuoteChecks({ ...stored, revision: "fake" })).toBeNull();
    expect(parseChatQuoteChecks({ ...stored, checks: [] })).toBeNull();
  });
});
