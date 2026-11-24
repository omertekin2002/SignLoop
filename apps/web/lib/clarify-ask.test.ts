import { describe, expect, it } from "vitest";
import {
  clarifyBeforeSigning,
  type ClarifyChecklist,
} from "@/lib/analysis-clarify";
import {
  askAboutItemHref,
  clarifyItemDraft,
  contractChatDraft,
  findingItemKey,
  isClarifyItemKey,
  questionItemKey,
  unstatedItemKey,
  unverifiedItemKey,
} from "@/lib/clarify-ask";
import { NOTICE_CITATION } from "@/lib/source-citations";
import type { AnalysisResult } from "@/lib/schemas";

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const ANALYSIS_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const TITLE = "Gym membership";
const PREFIX = "About “Gym membership”: ";

// The notice period and an obligation are stated without a quotation; term, renewal and payment
// are not stated; two findings and two questions.
const RESULT = {
  coverage_notices: ["Only part of this contract was analysed."],
  summary: {
    what_it_is: "A gym membership agreement.",
    payments: { amount: null, frequency: null, fees: [] },
    term: { start: null, end: null, minimum_term: null },
    renewal: { auto_renew: null, renewal_period: null },
    cancellation: {
      how: "Write to the club.",
      notice_period_days: 30,
      notice_period_text: null,
      penalties: [],
    },
  },
  obligations: ["Keep the locker tidy"],
  red_flags: [
    { type: "Price increase", severity: 3, explanation: "", where: null, confidence: 60 },
    { type: "Auto-renewal trap", severity: 8, explanation: "", where: null, confidence: 80 },
  ],
  next_actions: {
    questions_to_ask: ["Can I cancel early?", "Is the joining fee refundable?"],
    email_templates: [],
  },
} as unknown as Partial<AnalysisResult>;

const checklist = () =>
  clarifyBeforeSigning({ contractId: CONTRACT_ID, resultJson: RESULT });

describe("item keys", () => {
  it("accepts only the fixed grammar", () => {
    for (const key of [
      "unverified-1",
      "unstated-notice",
      "unstated-renewal",
      "unstated-payment",
      "unstated-term",
      "finding-2",
      "question-12",
    ])
      expect(isClarifyItemKey(key), key).toBe(true);
    for (const key of [
      "",
      "unverified-0",
      "unverified-01",
      "finding-",
      "finding-12345",
      "question--1",
      "unstated-fee",
      "unstated-Notice",
      "coverage-1",
      "finding-1 ",
      "finding-1&x=y",
      " question-1",
      "Notice period",
      null,
      2,
    ])
      expect(isClarifyItemKey(key), String(key)).toBe(false);
  });

  it("builds keys from positions and names, never from text", () => {
    expect(unverifiedItemKey(0)).toBe("unverified-1");
    expect(unstatedItemKey("Notice period")).toBe("unstated-notice");
    expect(unstatedItemKey("Term")).toBe("unstated-term");
    expect(findingItemKey(2)).toBe("finding-2");
    expect(questionItemKey(1)).toBe("question-2");
  });

  it("links with only the two ids and the key", () => {
    const href = askAboutItemHref(CONTRACT_ID, ANALYSIS_ID, "finding-2");
    expect(href).toBe(
      `/dashboard?contract=${CONTRACT_ID}&analysis=${ANALYSIS_ID}&ask=finding-2`,
    );
    const params = new URL(href, "https://app.test").searchParams;
    expect([...params.keys()]).toEqual(["contract", "analysis", "ask"]);
  });
});

describe("clarifyItemDraft", () => {
  it("asks which clause states an unverified fact, quoting its stored value", () => {
    const list = checklist();
    expect(list.unverified.map((fact) => fact.fact)).toEqual([
      "Notice period",
      "Obligation",
    ]);
    expect(clarifyItemDraft(TITLE, list, "unverified-1")).toBe(
      `${PREFIX}The analysis states this notice period: “30 days”, but found no quotation for it. Which clause states it? Quote it, or say none was found.`,
    );
    expect(clarifyItemDraft(TITLE, list, "unverified-2")).toBe(
      `${PREFIX}The analysis states this obligation: “Keep the locker tidy”, but found no quotation for it. Which clause states it? Quote it, or say none was found.`,
    );
  });

  it("asks whether the contract addresses an unstated fact", () => {
    const list = checklist();
    expect(clarifyItemDraft(TITLE, list, "unstated-renewal")).toBe(
      `${PREFIX}The analysis found no renewal terms in the contract. Does the contract address it anywhere? Quote the clause, or say none was found.`,
    );
    expect(clarifyItemDraft(TITLE, list, "unstated-payment")).toContain(
      "found no payment terms",
    );
    expect(clarifyItemDraft(TITLE, list, "unstated-term")).toContain(
      "found no term (start, end or minimum term)",
    );
  });

  it("asks to explain a finding by its stored position, whatever the checklist's order", () => {
    const list = checklist();
    // Sorted by severity, so the second stored finding comes first.
    expect(list.findings.map((finding) => finding.number)).toEqual([2, 1]);
    expect(clarifyItemDraft(TITLE, list, "finding-2")).toBe(
      `${PREFIX}Explain the finding “Auto-renewal trap”: which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.`,
    );
    expect(clarifyItemDraft(TITLE, list, "finding-1")).toContain(
      "the finding “Price increase”",
    );
  });

  it("disambiguates findings that share a type (and even a clause location) using number, location and explanation", () => {
    const duplicateResult: Partial<AnalysisResult> = {
      red_flags: [
        {
          type: "Indemnity",
          severity: 8,
          explanation: "Uncapped IP indemnity.",
          where: "Clause 9.2",
          evidence: null,
          citation: null,
          confidence: 80,
        },
        {
          type: "Indemnity",
          severity: 6,
          explanation: "Third-party claim indemnity.",
          where: "Clause 9.2",
          evidence: null,
          citation: null,
          confidence: 70,
        },
        {
          type: "Indemnity",
          severity: 5,
          explanation: "Data breach indemnity.",
          where: "Clause 12",
          evidence: null,
          citation: null,
          confidence: 70,
        },
      ],
    };
    const list = clarifyBeforeSigning({ contractId: CONTRACT_ID, resultJson: duplicateResult });
    expect(clarifyItemDraft(TITLE, list, "finding-1", duplicateResult)).toBe(
      `${PREFIX}Explain finding 1 (“Indemnity”, Clause 9.2 — Uncapped IP indemnity.): which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.`,
    );
    expect(clarifyItemDraft(TITLE, list, "finding-2", duplicateResult)).toBe(
      `${PREFIX}Explain finding 2 (“Indemnity”, Clause 9.2 — Third-party claim indemnity.): which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.`,
    );
    expect(clarifyItemDraft(TITLE, list, "finding-3", duplicateResult)).toBe(
      `${PREFIX}Explain finding 3 (“Indemnity”, Clause 12): which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.`,
    );
    expect(clarifyItemDraft(TITLE, list, "finding-2")).toBe(
      `${PREFIX}Explain finding 2 (“Indemnity”): which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.`,
    );

    // An overlong `where` value is truncated so the drafted prompt never exceeds the chat limit,
    // and two findings whose locations match after truncation still include their explanations.
    const sharedPrefix = `Clause ${"x".repeat(4500)}`;
    const longWhereResult: Partial<AnalysisResult> = {
      red_flags: [
        {
          type: "Indemnity",
          severity: 8,
          explanation: "Uncapped IP indemnity.",
          where: `${sharedPrefix} A`,
          evidence: null,
          citation: null,
          confidence: 80,
        },
        {
          type: "Indemnity",
          severity: 6,
          explanation: "Third-party claim indemnity.",
          where: `${sharedPrefix} B`,
          evidence: null,
          citation: null,
          confidence: 70,
        },
      ],
    };
    const longList = clarifyBeforeSigning({
      contractId: CONTRACT_ID,
      resultJson: longWhereResult,
    });
    const longDraft1 = clarifyItemDraft(TITLE, longList, "finding-1", longWhereResult);
    const longDraft2 = clarifyItemDraft(TITLE, longList, "finding-2", longWhereResult);
    expect(longDraft1.length).toBeLessThan(500);
    expect(longDraft1).toContain("…");
    expect(longDraft1).toContain("Uncapped IP indemnity.");
    expect(longDraft2).toContain("Third-party claim indemnity.");
  });

  it("asks the analysis's question, answered from the contract", () => {
    expect(clarifyItemDraft(TITLE, checklist(), "question-2")).toBe(
      `${PREFIX}Is the joining fee refundable? Answer from the contract and quote the clause you rely on.`,
    );
  });

  it("falls back to the plain contract draft when the key names no item", () => {
    const list = checklist();
    const plain = contractChatDraft(TITLE);
    // Notice period is stated, so it is not unstated; positions past the lists; after a re-analysis.
    for (const key of [
      "unstated-notice",
      "unverified-3",
      "finding-3",
      "question-3",
      "coverage-1",
      "finding-x",
      "",
    ])
      expect(clarifyItemDraft(TITLE, list, key), key).toBe(plain);
  });

  it("falls back to the plain contract draft without a checklist (no analysis, or not the named one)", () => {
    expect(clarifyItemDraft(TITLE, null, "finding-1")).toBe(contractChatDraft(TITLE));
    // An analysis with nothing stored lists no findings or questions.
    const empty = clarifyBeforeSigning({ contractId: CONTRACT_ID, resultJson: null });
    expect(clarifyItemDraft(TITLE, empty, "finding-1")).toBe(contractChatDraft(TITLE));
    expect(clarifyItemDraft(TITLE, empty, "question-1")).toBe(contractChatDraft(TITLE));
  });

  it("never puts a placeholder value into a draft", () => {
    const list: ClarifyChecklist = {
      coverageGaps: [],
      unverified: [{ fact: "Fee", value: "Not specified", ref: NOTICE_CITATION }],
      everyStatedFactQuoted: false,
      unstated: [],
      findings: [{ number: 1, type: "General risk", severity: 5 }],
      questions: ["N/A"],
    };
    const fee = clarifyItemDraft(TITLE, list, "unverified-1");
    expect(fee).toBe(
      `${PREFIX}The analysis states a fee but found no quotation for it. Which clause states it? Quote it, or say none was found.`,
    );
    expect(fee).not.toMatch(/not specified/i);
    // A placeholder finding type or question leaves nothing to identify the item by (the chat
    // cannot see the analysis's numbered findings), so the plain draft is used.
    expect(clarifyItemDraft(TITLE, list, "finding-1")).toBe(contractChatDraft(TITLE));
    expect(clarifyItemDraft(TITLE, list, "question-1")).toBe(contractChatDraft(TITLE));
  });
});
