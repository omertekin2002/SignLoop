import type {
  ClarifyChecklist,
  ClarifyUnstatedFact,
} from "@/lib/analysis-clarify";
import type { AnalysisResult } from "@/lib/schemas";
import { isSubstantiveText } from "@/lib/substantive-text";

/**
 * Asking about one "Before you sign" item in a saved chat about the contract. The link carries only
 * the contract's id, the analysis's id and a structural item key; the browser rebuilds the
 * checklist from that stored analysis and drafts the question from the item it names, so no item
 * text, value or title ever travels in a URL.
 */

/** The four singular facts' keys, in the checklist's order. */
const UNSTATED_KEYS = {
  "Notice period": "notice",
  Renewal: "renewal",
  Payment: "payment",
  Term: "term",
} as const satisfies Record<ClarifyUnstatedFact["fact"], string>;

type UnstatedKey = (typeof UNSTATED_KEYS)[keyof typeof UNSTATED_KEYS];

/**
 * An item's key: `unverified-<n>` and `question-<n>` by 1-based position in the checklist's list,
 * `unstated-<notice|renewal|payment|term>`, and `finding-<number>` by the finding's 1-based stored
 * position (the number the checklist already links by).
 */
export type ClarifyItemKey =
  | `unverified-${number}`
  | `unstated-${UnstatedKey}`
  | `finding-${number}`
  | `question-${number}`;

const ITEM_KEY_RE =
  /^(?:(?:unverified|finding|question)-[1-9]\d{0,3}|unstated-(?:notice|renewal|payment|term))$/;

/** True only for a key in the fixed grammar; anything else is dropped from the URL. */
export function isClarifyItemKey(value: unknown): value is ClarifyItemKey {
  return typeof value === "string" && ITEM_KEY_RE.test(value);
}

export function unverifiedItemKey(index: number): ClarifyItemKey {
  return `unverified-${index + 1}`;
}

export function unstatedItemKey(fact: ClarifyUnstatedFact["fact"]): ClarifyItemKey {
  return `unstated-${UNSTATED_KEYS[fact]}`;
}

export function findingItemKey(number: number): ClarifyItemKey {
  return `finding-${number}`;
}

export function questionItemKey(index: number): ClarifyItemKey {
  return `question-${index + 1}`;
}

/** The dashboard link that opens a new saved chat about one item: ids and a key, nothing else. */
export function askAboutItemHref(
  contractId: string,
  analysisId: string,
  key: ClarifyItemKey,
): string {
  const params = new URLSearchParams({
    contract: contractId,
    analysis: analysisId,
    ask: key,
  });
  return `/dashboard?${params.toString()}`;
}

/** The editable draft a chat about a contract starts with; it is never sent automatically. */
export function contractChatDraft(title: string): string {
  return `About “${title}”: `;
}

/** How each unstated fact reads in a question about where the contract addresses it. */
const UNSTATED_WORDING: Record<ClarifyUnstatedFact["fact"], string> = {
  "Notice period": "notice period",
  Renewal: "renewal terms",
  Payment: "payment terms",
  Term: "term (start, end or minimum term)",
};

const QUOTE_OR_NONE = "Quote the clause, or say none was found.";

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function substantive(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && isSubstantiveText(trimmed) ? trimmed : null;
}

/** Shorten a finding detail kept in a disambiguated draft without slicing mid-code-point. */
const MAX_FINDING_DETAIL = 120;
function shortenDetail(value: string): string {
  const chars = Array.from(value);
  return chars.length > MAX_FINDING_DETAIL
    ? `${chars.slice(0, MAX_FINDING_DETAIL - 1).join("").trimEnd()}…`
    : value;
}

/** The question for one item, or null when the key names no item in this checklist. */
function itemQuestion(
  checklist: ClarifyChecklist,
  key: string,
  result?: Partial<AnalysisResult> | null,
): string | null {
  if (!isClarifyItemKey(key)) return null;
  const separator = key.indexOf("-");
  const kind = key.slice(0, separator);
  const rest = key.slice(separator + 1);

  if (kind === "unstated") {
    const item = checklist.unstated.find(
      (fact) => UNSTATED_KEYS[fact.fact] === rest,
    );
    if (!item) return null;
    return `The analysis found no ${UNSTATED_WORDING[item.fact]} in the contract. Does the contract address it anywhere? ${QUOTE_OR_NONE}`;
  }

  const position = Number(rest);
  if (kind === "unverified") {
    const item = checklist.unverified[position - 1];
    if (!item) return null;
    const fact = lowerFirst(item.fact);
    const value = substantive(item.value);
    return value
      ? `The analysis states this ${fact}: “${value}”, but found no quotation for it. Which clause states it? Quote it, or say none was found.`
      : `The analysis states a ${fact} but found no quotation for it. Which clause states it? Quote it, or say none was found.`;
  }

  if (kind === "finding") {
    const item = checklist.findings.find((finding) => finding.number === position);
    // A placeholder type ("General risk") leaves nothing the chat could find the finding by: it
    // sees the contract's text, not the analysis's numbered findings.
    const type = item ? substantive(item.type) : null;
    if (!type || !item) return null;
    const sameType = checklist.findings.filter(
      (finding) =>
        finding.type.trim().toLowerCase() === item.type.trim().toLowerCase(),
    );
    if (sameType.length > 1) {
      const storedFlag = Array.isArray(result?.red_flags)
        ? result.red_flags[position - 1]
        : undefined;
      const where =
        typeof storedFlag?.where === "string"
          ? substantive(storedFlag.where)
          : null;
      const explanation =
        typeof storedFlag?.explanation === "string"
          ? substantive(storedFlag.explanation)
          : null;
      const whereText = where ? shortenDetail(where) : null;
      const sharedWhere =
        whereText !== null &&
        sameType.filter((finding) => {
          const other = Array.isArray(result?.red_flags)
            ? result.red_flags[finding.number - 1]
            : undefined;
          const otherWhere =
            typeof other?.where === "string" ? substantive(other.where) : null;
          const otherWhereText = otherWhere ? shortenDetail(otherWhere) : null;
          return otherWhereText?.toLowerCase() === whereText.toLowerCase();
        }).length > 1;
      const detail = sharedWhere
        ? [whereText, explanation ? shortenDetail(explanation) : null]
            .filter(Boolean)
            .join(" — ")
        : (whereText ?? (explanation ? shortenDetail(explanation) : null));
      if (detail) {
        return `Explain finding ${item.number} (“${type}”, ${detail}): which clause it relies on, and what I should clarify before signing. ${QUOTE_OR_NONE}`;
      }
      return `Explain finding ${item.number} (“${type}”): which clause it relies on, and what I should clarify before signing. ${QUOTE_OR_NONE}`;
    }
    return `Explain the finding “${type}”: which clause it relies on, and what I should clarify before signing. ${QUOTE_OR_NONE}`;
  }

  // A question.
  const question = checklist.questions[position - 1];
  const text = question ? substantive(question) : null;
  if (!text) return null;
  return `${text} Answer from the contract and quote the clause you rely on.`;
}

/**
 * The draft for asking about one checklist item, built only from the stored analysis's checklist.
 * When the checklist is missing (no analysis, or not the one the link named) or the key names no
 * item in it (for example after a re-analysis), it falls back to the plain contract draft.
 */
export function clarifyItemDraft(
  title: string,
  checklist: ClarifyChecklist | null,
  key: string,
  result?: Partial<AnalysisResult> | null,
): string {
  const question = checklist ? itemQuestion(checklist, key, result) : null;
  return question
    ? `${contractChatDraft(title)}${question}`
    : contractChatDraft(title);
}
