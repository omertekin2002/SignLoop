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

  it("keeps a lazy continuation line in the blockquote, as the renderer does, so an altered ending is checked", () => {
    const reply = [
      "> The Client will pay a monthly fee of 1,200 GBP,",
      "with no interest ever charged on late payments.",
      "",
      "> A late payment fee of 50 GBP applies",
      "- but this list item is not part of it",
      "> Late payments accrue interest",
      "# Neither is this heading",
    ].join("\n");
    const quotations = extractQuotations(reply);
    expect(quotations).toEqual([
      "The Client will pay a monthly fee of 1,200 GBP, with no interest ever charged on late payments",
      "A late payment fee of 50 GBP applies",
      "Late payments accrue interest",
    ]);
    expect(checkQuotations(quotations, CONTRACT).map((check) => check.status)).toEqual([
      "not_found",
      "found",
      "found",
    ]);
  });

  it("drops emphasis markup the chat renders away, keeping intraword underscores, escapes and a lone asterisk", () => {
    expect(
      extractQuotations(
        [
          "> *The Provider may review the monthly fee once a year, on 1 April.*",
          "",
          "> _Late payments accrue interest at 4% per month_",
          "",
          "> __This agreement is governed__ by the ***laws of England and Wales***.",
          "",
          "> **Clause 4:** the value_in_snake_case stays \\*as written\\* and 2 * 3 too",
          "",
          'It says "*the Provider will design, host and maintain* the Client\'s website".',
        ].join("\n"),
      ),
    ).toEqual([
      "The Provider may review the monthly fee once a year, on 1 April",
      "Late payments accrue interest at 4% per month",
      "This agreement is governed by the laws of England and Wales",
      "Clause 4: the value_in_snake_case stays *as written* and 2 * 3 too",
      "the Provider will design, host and maintain the Client's website",
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

  it("uses a short lead-in quotation in a blockquote, without dropping surrounding blockquote text", () => {
    expect(
      extractQuotations(
        '> **Clause 4** says "the Provider\'s total liability under this agreement is limited".',
      ),
    ).toEqual(["the Provider's total liability under this agreement is limited"]);
    expect(
      extractQuotations("> “This agreement is governed by the laws of England and Wales.”"),
    ).toEqual(["This agreement is governed by the laws of England and Wales"]);
    // A blockquote wrapped in straight quotes keeps inner defined terms whole.
    expect(
      extractQuotations(
        '> "The "Client" must give sixty days written notice before the renewal date."',
      ),
    ).toEqual(['The "Client" must give sixty days written notice before the renewal date']);
    // Text outside an inner quote in a blockquote is never dropped so altered clauses stay checked.
    expect(
      extractQuotations(
        '> Notice must state "I hereby cancel this agreement effective immediately" within 2 days.',
      ),
    ).toEqual([
      'Notice must state "I hereby cancel this agreement effective immediately" within 2 days',
    ]);
    // Substantive short prefixes before an inner quote are kept too (only source intros are stripped).
    expect(
      extractQuotations(
        '> The tenant need not give "written notice at least thirty days before renewal".',
      ),
    ).toEqual([
      'The tenant need not give "written notice at least thirty days before renewal"',
    ]);
    expect(
      extractQuotations(
        '> Clause excludes "written notice at least thirty days before renewal".',
      ),
    ).toEqual([
      'Clause excludes "written notice at least thirty days before renewal"',
    ]);
  });

  it("drops an adjacent source attribution line while preserving dash-led clause continuations", () => {
    expect(
      extractQuotations(
        [
          "> Late payments accrue interest at 4% per month until paid in full.",
          "> — Clause 2, Fees",
        ].join("\n"),
      ),
    ).toEqual(["Late payments accrue interest at 4% per month until paid in full"]);
    expect(
      extractQuotations(
        [
          "> The Client may terminate early",
          "> — only if the provider consents",
        ].join("\n"),
      ),
    ).toEqual(["The Client may terminate early — only if the provider consents"]);
    expect(
      extractQuotations(
        [
          "> Late payments accrue interest",
          "> — Section 4 may impose a fee.",
          ">",
          "> — Section 4: No interest accrues before notice.",
          ">",
          "> The tenant may cancel at any time",
          "> — Section 4 (Cancellation takes effect only after sixty days.)",
          ">",
          "> The tenant may cancel at any time",
          "> — Section 4 (Payment is required)",
        ].join("\n"),
      ),
    ).toEqual([
      "Late payments accrue interest — Section 4 may impose a fee",
      "— Section 4: No interest accrues before notice",
      "The tenant may cancel at any time — Section 4 (Cancellation takes effect only after sixty days.)",
      "The tenant may cancel at any time — Section 4 (Payment is required)",
    ]);
  });

  it("handles nested emphasis, non-flanking asterisks, escaped backticks, curly quotes in code spans, blanks and escaped quotes", () => {
    expect(
      extractQuotations(
        [
          "> *due *only* on Friday*",
          "",
          "> The fee is $500*, plus taxes*, payable on ____ of each month.",
          "",
          "> The tenant may \\`not\\` terminate early",
          "",
          "> Clause 4 says `“the Client may cancel after thirty days”`",
          "",
          'It says "The \\"Client\\" must pay within thirty days of invoice."',
        ].join("\n"),
      ),
    ).toEqual([
      "due only on Friday",
      "The fee is $500*, plus taxes*, payable on ____ of each month",
      "The tenant may `not` terminate early",
      "Clause 4 says “the Client may cancel after thirty days”",
      'The "Client" must pay within thirty days of invoice',
    ]);
  });

  it("ignores prose code spans and fenced code blocks, while keeping inline-code text literal inside blockquotes", () => {
    expect(
      extractQuotations(
        [
          'Run `grep "Either party may end this lease on notice" lease.txt` to search.',
          'See [`"Either party may end this lease on notice"`](https://example.com).',
          "```",
          "> Either party may end this lease on six months' notice",
          'const text = "Either party may end this lease on six months notice";',
          "```",
          "~~~text",
          'echo "The Tenant will pay rent on the first day"',
          "~~~",
          "> The tenant may `not` terminate early",
          ">",
          "> Fees are `*not refundable*` after signing",
        ].join("\n"),
      ),
    ).toEqual([
      "The tenant may not terminate early",
      "Fees are *not refundable* after signing",
    ]);
    expect(
      checkQuotations(
        extractQuotations("> The tenant may `not` terminate early"),
        "The tenant may terminate early.",
      ),
    ).toEqual([{ quote: "The tenant may not terminate early", status: "not_found" }]);
    expect(
      checkQuotations(
        extractQuotations("> Fees are `*not refundable*` after signing"),
        "Fees are not refundable after signing.",
      ),
    ).toEqual([{ quote: "Fees are *not refundable* after signing", status: "not_found" }]);
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
