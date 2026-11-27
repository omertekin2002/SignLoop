import type {
  ClarifyChecklist,
  ClarifyUnstatedFact,
} from "@/lib/analysis-clarify";
import type { AnalysisResult } from "@/lib/schemas";
import {
  citationForReport,
  normalizeQuotation,
  SourceIdentitySchema,
} from "@/lib/source-citations";
import { isRecord } from "@/lib/utils";

/**
 * Stable keys for "Before you sign" items, so a decision saved against an item still finds it
 * after a re-analysis reorders the checklist. A key is built only from what identifies the item
 * (a fact's kind and stated value, a finding's type and verified quotation, a question's text),
 * never from its position or from wording a re-analysis rewrites (a finding's explanation).
 *
 * Pure and synchronous: the browser builds the checklist inside `useMemo`, so the hash is plain
 * JavaScript and needs neither `node:crypto` nor `crypto.subtle`.
 *
 * Keys are not shown, sent to the model or put in Ask URLs (`lib/clarify-ask.ts` keeps its
 * positional keys).
 */

/** Bumped when a key's inputs change, so decisions stored under an older scheme fall to "earlier". */
export const CLARIFY_KEY_VERSION = "v1";

/** One keyed item: its key, and whether another item in the same checklist has that key too. */
export type ClarifyKeyedItem = {
  key: string;
  /** True when the key names more than one item in this checklist; no decision attaches to it. */
  ambiguous: boolean;
};

/**
 * Keys parallel to a `ClarifyChecklist`: `unverified[i]` is the key of `checklist.unverified[i]`,
 * and so on. Coverage gaps get none.
 */
export type ClarifyChecklistKeys = {
  unverified: ClarifyKeyedItem[];
  unstated: ClarifyKeyedItem[];
  findings: ClarifyKeyedItem[];
  questions: ClarifyKeyedItem[];
};

const UNSTATED_KEYS = {
  "Notice period": "notice",
  Renewal: "renewal",
  Payment: "payment",
  Term: "term",
} as const satisfies Record<ClarifyUnstatedFact["fact"], string>;

/** The checklist's unverified fact labels (`clarifyBeforeSigning`) as key kinds. */
const UNVERIFIED_KINDS: Record<string, string> = {
  "Notice period": "notice",
  Renewal: "renewal",
  Payment: "payment",
  Term: "term",
  Fee: "fee",
  Penalty: "penalty",
  Obligation: "obligation",
  "Key date": "key-date",
};

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const utf8 = new TextEncoder();

/**
 * FNV-1a, 64 bits, over the text's UTF-8 bytes, as 16 lowercase hex digits. Synchronous and
 * identical in every JavaScript runtime. Not a security hash: keys only tell one person's own
 * checklist items apart, and a collision inside one checklist is caught as ambiguity.
 */
export function stableHash64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of utf8.encode(text)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV_PRIME);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Whitespace runs and quotation-mark style only, as `normalizeQuotation`, then trimmed. */
function normalize(value: string): string {
  return normalizeQuotation(value).trim();
}

/** Hashes a list of parts as JSON, so no choice of text can make two different lists collide. */
function hashParts(parts: (string | number)[]): string {
  return stableHash64(JSON.stringify(parts));
}

export function unstatedDecisionKey(fact: ClarifyUnstatedFact["fact"]): string {
  return `${CLARIFY_KEY_VERSION}:unstated:${UNSTATED_KEYS[fact]}`;
}

/** A stated fact without a verified quotation: its kind and stated value. A new value is a new item. */
export function unverifiedDecisionKey(fact: string, value: string): string {
  const kind =
    UNVERIFIED_KINDS[fact] ??
    (normalize(fact)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-") ||
      "fact");
  return `${CLARIFY_KEY_VERSION}:unverified:${kind}:${hashParts([normalize(value)])}`;
}

/**
 * A finding: its type and its verified quotation's text and span, or its type and `where` when it
 * has no verified quotation. The explanation is left out, since a re-analysis rewords it.
 */
export function findingDecisionKey(
  type: string,
  anchor:
    { quote: string; start: number; end: number } | { where: string | null },
): string {
  const parts =
    "quote" in anchor
      ? [
          "quote",
          normalize(type),
          normalize(anchor.quote),
          anchor.start,
          anchor.end,
        ]
      : ["where", normalize(type), normalize(anchor.where ?? "")];
  return `${CLARIFY_KEY_VERSION}:finding:${hashParts(parts)}`;
}

export function questionDecisionKey(question: string): string {
  return `${CLARIFY_KEY_VERSION}:question:${hashParts([normalize(question)])}`;
}

export type ClarifyKeysInput = {
  contractId: string;
  resultJson?: Partial<AnalysisResult> | null;
};

/**
 * The key of every keyed item in `checklist`, which must be `clarifyBeforeSigning` of the same
 * stored analysis. A finding's verified quotation is read from that analysis by the finding's
 * stored position (`number`), checked as the page checks it (`citationForReport`). An analysis
 * saved before quotations existed still gets keys: its findings are keyed by type and `where`.
 */
export function clarifyChecklistKeys(
  checklist: ClarifyChecklist,
  input: ClarifyKeysInput,
): ClarifyChecklistKeys {
  const result = isRecord(input.resultJson) ? input.resultJson : {};
  const redFlags = Array.isArray(result.red_flags) ? result.red_flags : [];

  const unverified = checklist.unverified.map((item) =>
    unverifiedDecisionKey(item.fact, item.value),
  );
  const unstated = checklist.unstated.map((item) =>
    unstatedDecisionKey(item.fact),
  );
  const findings = checklist.findings.map((finding) => {
    const citation = citationForReport(
      result,
      input.contractId,
      finding.number - 1,
    );
    if (citation) return findingDecisionKey(finding.type, citation);
    const flag: unknown = redFlags[finding.number - 1];
    const where =
      isRecord(flag) && typeof flag.where === "string" ? flag.where : null;
    return findingDecisionKey(finding.type, { where });
  });
  const questions = checklist.questions.map(questionDecisionKey);

  const counts = new Map<string, number>();
  for (const key of [...unverified, ...unstated, ...findings, ...questions]) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keyed = (keys: string[]): ClarifyKeyedItem[] =>
    keys.map((key) => ({ key, ambiguous: (counts.get(key) ?? 0) > 1 }));

  return {
    unverified: keyed(unverified),
    unstated: keyed(unstated),
    findings: keyed(findings),
    questions: keyed(questions),
  };
}

/**
 * The stored analysis's source revision (`source.revision`, from `contractSourceRevision`), or
 * null when it has none (an analysis saved before quotations existed) or names another contract.
 */
export function analysisSourceRevision(
  contractId: string,
  resultJson: unknown,
): string | null {
  if (!isRecord(resultJson)) return null;
  const source = SourceIdentitySchema.safeParse(resultJson.source);
  if (
    !source.success ||
    source.data.contract_id.toLowerCase() !== contractId.toLowerCase()
  )
    return null;
  return source.data.revision;
}

/** What a decision needs for matching; the rest of it passes through untouched. */
export type ClarifyDecisionRef = {
  itemKey: string;
  sourceRevision: string | null;
};

export type ClarifyDecisionMatch<D extends ClarifyDecisionRef> = {
  /** Decisions shown on their item, by the item's key. */
  matched: Map<string, D>;
  /** Every other decision, in input order: none is dropped, and none is re-attached by guessing. */
  earlier: D[];
};

/**
 * Attaches saved decisions to the current checklist. A decision matches only when its source
 * revision is the analysis's (`analysisSourceRevision`) and its key names exactly one unambiguous
 * item. When two decisions name the same item, neither is chosen over the other: both go to
 * `earlier`. With no source revision, every decision goes to `earlier`.
 */
export function matchClarifyDecisions<D extends ClarifyDecisionRef>(
  decisions: readonly D[],
  keys: ClarifyChecklistKeys,
  sourceRevision: string | null | undefined,
): ClarifyDecisionMatch<D> {
  const unambiguous = new Set<string>();
  for (const item of [
    ...keys.unverified,
    ...keys.unstated,
    ...keys.findings,
    ...keys.questions,
  ]) {
    if (!item.ambiguous) unambiguous.add(item.key);
  }

  const candidates = (decision: D) =>
    Boolean(sourceRevision) &&
    decision.sourceRevision === sourceRevision &&
    unambiguous.has(decision.itemKey);
  const perKey = new Map<string, number>();
  for (const decision of decisions) {
    if (candidates(decision)) {
      perKey.set(decision.itemKey, (perKey.get(decision.itemKey) ?? 0) + 1);
    }
  }

  const matched = new Map<string, D>();
  const earlier: D[] = [];
  for (const decision of decisions) {
    if (candidates(decision) && perKey.get(decision.itemKey) === 1) {
      matched.set(decision.itemKey, decision);
    } else {
      earlier.push(decision);
    }
  }
  return { matched, earlier };
}
