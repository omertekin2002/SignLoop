import { describe, expect, it } from "vitest";
import { clarifyBeforeSigning } from "@/lib/analysis-clarify";
import { contractSourceRevision } from "@/lib/analysis-sources";
import {
  analysisSourceRevision,
  clarifyChecklistKeys,
  matchClarifyDecisions,
  stableHash64,
  type ClarifyChecklistKeys,
  type ClarifyDecisionRef,
} from "@/lib/clarify-keys";
import {
  citation,
  CONTRACT_ID,
  CONTRACT_TEXT,
  REVISION,
  SOURCE,
  storedAnalysis,
  type StoredAnalysis,
} from "@/lib/fixtures/clarify-analysis";
import { PINNED_KEYS } from "@/lib/fixtures/clarify-keys-pinned";

function keysOf(result: StoredAnalysis | Record<string, unknown>) {
  const checklist = clarifyBeforeSigning({
    contractId: CONTRACT_ID,
    resultJson: result as StoredAnalysis,
  });
  return {
    checklist,
    keys: clarifyChecklistKeys(checklist, {
      contractId: CONTRACT_ID,
      resultJson: result as StoredAnalysis,
    }),
  };
}

/** Each item's key, by what the item says rather than where it sits. */
function keysByItem(result: StoredAnalysis) {
  const { checklist, keys } = keysOf(result);
  const flags = result.red_flags ?? [];
  const byItem = new Map<string, string>();
  checklist.unverified.forEach((item, index) =>
    byItem.set(
      `unverified ${item.fact}: ${item.value}`,
      keys.unverified[index]!.key,
    ),
  );
  checklist.unstated.forEach((item, index) =>
    byItem.set(`unstated ${item.fact}`, keys.unstated[index]!.key),
  );
  checklist.findings.forEach((finding, index) => {
    const flag = flags[finding.number - 1]!;
    byItem.set(
      `finding ${flag.type} at ${flag.where}`,
      keys.findings[index]!.key,
    );
  });
  checklist.questions.forEach((question, index) =>
    byItem.set(`question ${question}`, keys.questions[index]!.key),
  );
  return byItem;
}

function allKeys(keys: ClarifyChecklistKeys) {
  return [
    ...keys.unverified,
    ...keys.unstated,
    ...keys.findings,
    ...keys.questions,
  ];
}

/** A report from before quotations existed: no source and no citation fields. */
function preQuotation(result: StoredAnalysis): StoredAnalysis {
  return JSON.parse(
    JSON.stringify(result, (key, value) =>
      key === "source" || key.endsWith("citation") || key.endsWith("citations")
        ? undefined
        : value,
    ),
  ) as StoredAnalysis;
}

function decision(
  itemKey: string,
  sourceRevision: string | null,
  note = itemKey,
) {
  return { itemKey, sourceRevision, status: "accepted", note };
}

describe("stableHash64", () => {
  it("is 64-bit FNV-1a over UTF-8, as the published test vectors give it", () => {
    expect(stableHash64("")).toBe("cbf29ce484222325");
    expect(stableHash64("a")).toBe("af63dc4c8601ec8c");
    expect(stableHash64("foobar")).toBe("85944171f73967e8");
  });

  it("hashes code points beyond ASCII by their UTF-8 bytes, synchronously", () => {
    const hash = stableHash64("£45 😀");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toBe(stableHash64("£45 😁"));
    expect(typeof stableHash64("x")).toBe("string");
  });
});

describe("clarifyChecklistKeys", () => {
  it("keys every unverified fact, unstated fact, finding and question, and no coverage gap", () => {
    const { checklist, keys } = keysOf(storedAnalysis());

    expect(checklist.coverageGaps).toHaveLength(1);
    expect(Object.keys(keys)).toEqual([
      "unverified",
      "unstated",
      "findings",
      "questions",
    ]);
    expect(keys.unverified).toHaveLength(checklist.unverified.length);
    expect(keys.unstated).toHaveLength(checklist.unstated.length);
    expect(keys.findings).toHaveLength(checklist.findings.length);
    expect(keys.questions).toHaveLength(checklist.questions.length);
    expect(checklist.unverified.map((item) => item.fact)).toEqual([
      "Notice period",
      "Payment",
      "Fee",
      "Fee",
      "Key date",
    ]);
    expect(keys.unverified.map(({ key }) => key)).toEqual([
      expect.stringMatching(/^v1:unverified:notice:[0-9a-f]{16}$/),
      expect.stringMatching(/^v1:unverified:payment:[0-9a-f]{16}$/),
      expect.stringMatching(/^v1:unverified:fee:[0-9a-f]{16}$/),
      expect.stringMatching(/^v1:unverified:fee:[0-9a-f]{16}$/),
      expect.stringMatching(/^v1:unverified:key-date:[0-9a-f]{16}$/),
    ]);
    expect(keys.unstated).toEqual([
      { key: "v1:unstated:term", ambiguous: false },
    ]);
    for (const item of [...keys.findings, ...keys.questions]) {
      expect(item.key).toMatch(/^v1:(?:finding|question):[0-9a-f]{16}$/);
    }
    const all = allKeys(keys);
    expect(new Set(all.map(({ key }) => key)).size).toBe(all.length);
    expect(all.every(({ ambiguous }) => !ambiguous)).toBe(true);
  });

  it("gives the keys pinned for the browser test, so both environments agree", () => {
    expect(contractSourceRevision(CONTRACT_TEXT)).toBe(REVISION);
    expect(keysOf(storedAnalysis()).keys).toEqual(PINNED_KEYS);
  });

  it("is deterministic: the same stored analysis gives the same keys every time", () => {
    expect(keysOf(storedAnalysis()).keys).toEqual(
      keysOf(storedAnalysis()).keys,
    );
  });

  it("keeps every key when a re-analysis lists findings, questions and listed facts in another order", () => {
    const first = storedAnalysis();
    const second = storedAnalysis();
    second.red_flags = [...first.red_flags!].reverse();
    second.next_actions = {
      ...first.next_actions!,
      questions_to_ask: [...first.next_actions!.questions_to_ask].reverse(),
    };
    second.summary!.payments.fees = [...first.summary!.payments.fees].reverse();
    second.key_dates = [
      { type: "RENEWAL", date: "2027-06-01", derived_from: "Clause 3" },
      ...first.key_dates!,
    ];

    const before = keysByItem(first);
    const after = keysByItem(second);
    // The re-analysis adds one key date; every item the first one had keeps its key.
    for (const [item, key] of before) expect(after.get(item)).toBe(key);
    expect(after.size).toBe(before.size + 1);
  });

  it("keeps a finding's key when its explanation, severity or confidence is reworded", () => {
    const first = storedAnalysis();
    const second = storedAnalysis();
    second.red_flags = first.red_flags!.map((flag) => ({
      ...flag,
      explanation: `Reworded: ${flag.explanation}`,
      severity: 10 - (flag.severity ?? 0),
      confidence: 50,
    }));
    expect(keysByItem(second)).toEqual(keysByItem(first));
  });

  it("forgives whitespace and quotation-mark style only", () => {
    const first = storedAnalysis();
    const second = storedAnalysis();
    second.next_actions!.questions_to_ask = [
      "  Can the renewal\n be switched off? ",
      "How much is the early exit fee?",
    ];
    second.red_flags![1]!.where = "Clause  4";
    second.red_flags![1]!.type = " Exit fee";
    second.summary!.payments.fees = [
      "Joining fee of £20",
      "Late payment fee of £5",
    ];
    expect(keysOf(second).keys).toEqual(keysOf(first).keys);

    const curly = storedAnalysis();
    curly.next_actions!.questions_to_ask = ["What is the “exit fee”?", "x"];
    const straight = storedAnalysis();
    straight.next_actions!.questions_to_ask = ['What is the "exit fee"?', "x"];
    expect(keysOf(curly).keys.questions[0]).toEqual(
      keysOf(straight).keys.questions[0],
    );

    const lower = storedAnalysis();
    lower.next_actions!.questions_to_ask = ["can the renewal be switched off?"];
    expect(keysOf(lower).keys.questions[0]!.key).not.toBe(
      keysOf(first).keys.questions[0]!.key,
    );
  });

  it("changes a quoted finding's key when its type, quotation or span changes", () => {
    const quoted = (
      patch: (flag: NonNullable<StoredAnalysis["red_flags"]>[number]) => void,
    ) => {
      const result = storedAnalysis();
      patch(result.red_flags![0]!);
      const { checklist, keys } = keysOf(result);
      return keys.findings[
        checklist.findings.findIndex((finding) => finding.number === 1)
      ]!.key;
    };
    const original = quoted(() => {});
    expect(quoted((flag) => (flag.where = "Clause 99"))).toBe(original);
    expect(quoted((flag) => (flag.type = "Price rise"))).not.toBe(original);
    expect(
      quoted(
        (flag) => (flag.citation = citation("raise prices by 5% once a year.")),
      ),
    ).not.toBe(original);
    // The same words quoted from another place in the text are another clause.
    expect(
      quoted((flag) => {
        const moved = citation("The club may raise prices by 5% once a year.");
        flag.citation = {
          ...moved,
          start: moved.start + 1,
          end: moved.end + 1,
        };
      }),
    ).not.toBe(original);
  });

  it("keys a finding without a verified quotation by type and where, and changes it when where changes", () => {
    const unquoted = (where: string | null, type = "Exit fee") => {
      const result = storedAnalysis();
      Object.assign(result.red_flags![1]!, { where, type });
      const { checklist, keys } = keysOf(result);
      return keys.findings[
        checklist.findings.findIndex((finding) => finding.number === 2)
      ]!.key;
    };
    expect(unquoted("Clause 4")).toBe(unquoted("Clause 4"));
    expect(unquoted("Clause 5")).not.toBe(unquoted("Clause 4"));
    expect(unquoted("Clause 4", "Termination fee")).not.toBe(
      unquoted("Clause 4"),
    );
    expect(unquoted(null)).toMatch(/^v1:finding:[0-9a-f]{16}$/);

    // A quotation that does not verify (another revision) is not one: type and where key it.
    const verified = storedAnalysis();
    const stale = storedAnalysis();
    stale.red_flags![0]!.citation = citation(
      "The club may raise prices by 5% once a year.",
      `sha256:${"b".repeat(64)}`,
    );
    const withoutQuote = storedAnalysis();
    withoutQuote.red_flags![0]!.citation = null;
    const findingOne = (result: StoredAnalysis) => {
      const { checklist, keys } = keysOf(result);
      return keys.findings[
        checklist.findings.findIndex((finding) => finding.number === 1)
      ]!.key;
    };
    expect(findingOne(stale)).toBe(findingOne(withoutQuote));
    expect(findingOne(stale)).not.toBe(findingOne(verified));
  });

  it("changes an unverified fact's key when its stated value changes, and no other key", () => {
    const first = storedAnalysis();
    const second = storedAnalysis();
    second.summary!.payments.amount = "£49";
    const before = keysOf(first).keys;
    const after = keysOf(second).keys;
    expect(after.unverified[1]!.key).not.toBe(before.unverified[1]!.key);
    expect(after.unverified[1]!.key).toMatch(/^v1:unverified:payment:/);
    const withoutPayment = (keys: ClarifyChecklistKeys) => ({
      ...keys,
      unverified: keys.unverified.filter((_, index) => index !== 1),
    });
    expect(withoutPayment(after)).toEqual(withoutPayment(before));

    const notice = storedAnalysis();
    notice.summary!.cancellation.notice_period_days = 60;
    expect(keysOf(notice).keys.unverified[0]!.key).not.toBe(
      before.unverified[0]!.key,
    );

    // The same value under another kind of fact is another item.
    const sameText = storedAnalysis();
    sameText.summary!.payments.fees = ["Pay monthly dues"];
    sameText.obligations = ["Pay monthly dues"];
    const { checklist, keys } = keysOf(sameText);
    const fee =
      keys.unverified[
        checklist.unverified.findIndex((item) => item.fact === "Fee")
      ]!;
    const obligation =
      keys.unverified[
        checklist.unverified.findIndex((item) => item.fact === "Obligation")
      ]!;
    expect(fee.key).not.toBe(obligation.key);
    expect(fee.ambiguous || obligation.ambiguous).toBe(false);
  });

  it("marks both items ambiguous when two share a key", () => {
    const result = storedAnalysis();
    result.next_actions!.questions_to_ask = [
      "Is VAT included?",
      "Is VAT  included?",
      "Other?",
    ];
    result.summary!.payments.fees = ["Card fee of £1", "Card fee of £1"];
    // Two unquoted findings of one type in the same place.
    result.red_flags![2]!.where = "Clause 4";
    const { checklist, keys } = keysOf(result);

    expect(keys.questions.map(({ ambiguous }) => ambiguous)).toEqual([
      true,
      true,
      false,
    ]);
    expect(keys.questions[0]!.key).toBe(keys.questions[1]!.key);
    const fees = keys.unverified.filter(
      (_, index) => checklist.unverified[index]!.fact === "Fee",
    );
    expect(fees.map(({ ambiguous }) => ambiguous)).toEqual([true, true]);
    const exitFees = keys.findings.filter(
      (_, index) => checklist.findings[index]!.type === "Exit fee",
    );
    expect(exitFees.map(({ ambiguous }) => ambiguous)).toEqual([true, true]);
    expect(
      keys.findings.find(
        (_, index) => checklist.findings[index]!.type === "Price increase",
      )!.ambiguous,
    ).toBe(false);

    const decisions = [
      decision(keys.questions[0]!.key, REVISION),
      decision(fees[0]!.key, REVISION),
      decision(exitFees[0]!.key, REVISION),
      decision(keys.questions[2]!.key, REVISION),
    ];
    const { matched, earlier } = matchClarifyDecisions(
      decisions,
      keys,
      REVISION,
    );
    expect([...matched.keys()]).toEqual([keys.questions[2]!.key]);
    expect(earlier).toEqual(decisions.slice(0, 3));
  });

  it("still keys an analysis saved before quotations existed", () => {
    const { checklist, keys } = keysOf(preQuotation(storedAnalysis()));
    // Renewal now has no quotation, so it joins the unverified facts.
    expect(checklist.unverified.map((item) => item.fact)).toContain("Renewal");
    expect(keys.unverified).toHaveLength(checklist.unverified.length);
    expect(keys.findings).toHaveLength(3);
    expect(
      allKeys(keys).every(
        ({ key, ambiguous }) => key.startsWith("v1:") && !ambiguous,
      ),
    ).toBe(true);
    expect(keysOf(preQuotation(storedAnalysis())).keys).toEqual(keys);
  });

  it("keys nothing for an empty or missing analysis", () => {
    const { keys } = keysOf({});
    expect(keys.unverified).toEqual([]);
    expect(keys.findings).toEqual([]);
    expect(keys.questions).toEqual([]);
    expect(keys.unstated.map(({ key }) => key)).toEqual([
      "v1:unstated:notice",
      "v1:unstated:renewal",
      "v1:unstated:payment",
      "v1:unstated:term",
    ]);
    const checklist = clarifyBeforeSigning({
      contractId: CONTRACT_ID,
      resultJson: null,
    });
    expect(
      clarifyChecklistKeys(checklist, {
        contractId: CONTRACT_ID,
        resultJson: null,
      }),
    ).toEqual(keys);
  });
});

describe("analysisSourceRevision", () => {
  it("reads the stored analysis's source revision for its own contract only", () => {
    expect(analysisSourceRevision(CONTRACT_ID, storedAnalysis())).toBe(
      REVISION,
    );
    expect(
      analysisSourceRevision(CONTRACT_ID.toUpperCase(), storedAnalysis()),
    ).toBe(REVISION);
    expect(
      analysisSourceRevision(
        "99999999-2222-4333-8444-555555555555",
        storedAnalysis(),
      ),
    ).toBeNull();
    expect(
      analysisSourceRevision(CONTRACT_ID, preQuotation(storedAnalysis())),
    ).toBeNull();
    expect(analysisSourceRevision(CONTRACT_ID, null)).toBeNull();
    expect(
      analysisSourceRevision(CONTRACT_ID, {
        source: { ...SOURCE, revision: "x" },
      }),
    ).toBeNull();
  });
});

describe("matchClarifyDecisions", () => {
  const { keys } = keysOf(storedAnalysis());
  const payment = keys.unverified[1]!.key;
  const question = keys.questions[0]!.key;
  const term = keys.unstated[0]!.key;

  it("matches a decision on the same source revision and a unique key, passing it through whole", () => {
    const decisions = [
      decision(payment, REVISION, "Agreed £45"),
      decision(term, REVISION),
    ];
    const { matched, earlier } = matchClarifyDecisions(
      decisions,
      keys,
      REVISION,
    );
    expect(earlier).toEqual([]);
    expect(matched.get(payment)).toBe(decisions[0]);
    expect(matched.get(term)).toBe(decisions[1]);
    expect(matched.size).toBe(2);
  });

  it("puts every other decision in earlier, in input order, dropping none", () => {
    const otherRevision = `sha256:${"c".repeat(64)}`;
    const decisions = [
      decision(payment, otherRevision),
      decision("v1:question:0000000000000000", REVISION),
      decision(question, REVISION),
      decision(payment, null),
      decision(`v0:${question.slice(3)}`, REVISION),
      // Two decisions for one item: neither is chosen over the other.
      decision(term, REVISION, "first"),
      decision(term, REVISION, "second"),
    ];
    const { matched, earlier } = matchClarifyDecisions(
      decisions,
      keys,
      REVISION,
    );
    expect([...matched.entries()]).toEqual([[question, decisions[2]]]);
    expect(earlier).toEqual([
      decisions[0],
      decisions[1],
      decisions[3],
      decisions[4],
      decisions[5],
      decisions[6],
    ]);
    expect(matched.size + earlier.length).toBe(decisions.length);
  });

  it("puts every decision in earlier when the analysis has no source revision", () => {
    const old = preQuotation(storedAnalysis());
    const { keys: oldKeys } = keysOf(old);
    const decisions: ClarifyDecisionRef[] = [
      decision(oldKeys.questions[0]!.key, null),
      decision(oldKeys.questions[0]!.key, REVISION),
      decision(oldKeys.unstated[0]!.key, ""),
    ];
    for (const revision of [
      analysisSourceRevision(CONTRACT_ID, old),
      undefined,
      "",
    ]) {
      const { matched, earlier } = matchClarifyDecisions(
        decisions,
        oldKeys,
        revision,
      );
      expect(matched.size).toBe(0);
      expect(earlier).toEqual(decisions);
    }
  });

  it("carries decisions onto a reordered re-analysis of the same text, and none onto changed items", () => {
    const first = storedAnalysis();
    const firstKeys = keysOf(first).keys;
    const decisions = allKeys(firstKeys).map(({ key }) =>
      decision(key, REVISION),
    );

    const reordered = storedAnalysis();
    reordered.red_flags = [...first.red_flags!].reverse().map((flag) => ({
      ...flag,
      explanation: `${flag.explanation} (reworded)`,
    }));
    reordered.next_actions!.questions_to_ask = [
      ...first.next_actions!.questions_to_ask,
    ].reverse();
    const again = matchClarifyDecisions(
      decisions,
      keysOf(reordered).keys,
      analysisSourceRevision(CONTRACT_ID, reordered),
    );
    expect(again.earlier).toEqual([]);
    expect(again.matched.size).toBe(decisions.length);

    const changed = storedAnalysis();
    changed.summary!.payments.amount = "£49";
    changed.next_actions!.questions_to_ask = ["Can the renewal be cancelled?"];
    const partly = matchClarifyDecisions(
      decisions,
      keysOf(changed).keys,
      analysisSourceRevision(CONTRACT_ID, changed),
    );
    expect(partly.earlier.map(({ itemKey }) => itemKey)).toEqual([
      firstKeys.unverified[1]!.key,
      ...firstKeys.questions.map(({ key }) => key),
    ]);
    expect(partly.matched.size + partly.earlier.length).toBe(decisions.length);

    // A new text (another revision) carries no decision, even onto identical items.
    const newText = storedAnalysis();
    newText.source = { ...SOURCE, revision: `sha256:${"d".repeat(64)}` };
    const none = matchClarifyDecisions(
      decisions,
      keysOf(newText).keys,
      analysisSourceRevision(CONTRACT_ID, newText),
    );
    expect(none.matched.size).toBe(0);
    expect(none.earlier).toEqual(decisions);
  });
});
