import { isSubstantiveText, type AnalysisResult } from "@/lib/schemas";
import {
  citationForReport,
  JURISDICTION_CITATION,
  MAX_EVIDENCE_QUOTE,
  verifyQuote,
  type ContractSegment,
  type SourceCitation,
} from "@/lib/source-citations";
import type { DurationUnit, FieldPath } from "./case-schema";
import type { LoadedCase, LocatedClause } from "./dataset";
import {
  normalizeLabel,
  resolveCategories,
  type ClauseCategory,
} from "./taxonomy";

/** A gold clause is found when at least this share of a verified quotation lies inside it. */
export const CLAUSE_OVERLAP_THRESHOLD = 0.5;
/** Matches the contract view, which renders severity 7 and above as high risk. */
export const HIGH_SEVERITY = 7;
/** Share of a failed quotation's words present, in any order, in one same-length window. */
export const NEAR_MISS_THRESHOLD = 0.7;

/**
 * How production accepted the output, as far as it is observable without production hooks:
 * "rejected" is a validation failure, "failed" a provider or request failure, and "unobserved"
 * output that needed syntax salvage, where strict and partial cannot be told apart.
 */
export type ParsePath =
  "strict" | "partial" | "normalized" | "rejected" | "failed" | "unobserved";

export type RunOutput = {
  /** analyzeText's result, which still carries the model's evidence proposals. */
  analysis: AnalysisResult | null;
  /** The report as stored by finalizeAnalysisResult, with verified citations. */
  stored: Record<string, unknown> | null;
  parsePath: ParsePath;
  /** The prompt actually sent, for diagnosing quotations copied from it. */
  prompt?: string | null;
};

export type FieldOutcome =
  | "correct"
  | "wrong"
  | "false_abstention"
  | "correct_abstention"
  | "fabricated"
  | "no_result";

export type QuoteDiagnosis =
  | "too_long"
  | "ambiguous"
  | "wrong_segment"
  | "cross_section"
  | "segment_marker"
  | "quoted_context"
  | "quoted_prompt"
  | "whitespace_drift"
  | "typography_drift"
  | "unicode_drift"
  | "near_miss"
  | "fabricated";

type JsonRecord = Record<string, unknown>;
type MetricValue = number | string | boolean | null;
export type CaseMetrics = Record<string, MetricValue>;

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

function readPath(root: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((value, key) => asRecord(value)?.[key], root);
}

// --- Durations -------------------------------------------------------------------------------

type CanonicalDuration = [number, "day" | "business_day" | "month"];

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function wordNumber(words: string): number | null {
  let total = 0;
  for (const word of words.split("-")) {
    const value = NUMBER_WORDS[word];
    if (value === undefined) return null;
    total += value;
  }
  return total;
}

function canonicalUnit(value: number, unit: DurationUnit): CanonicalDuration {
  // Only exact conversions; business days and months never convert to calendar days.
  if (unit === "week") return [value * 7, "day"];
  if (unit === "year") return [value * 12, "month"];
  return [value, unit];
}

const DURATION_PATTERN =
  /\b(?:([a-z]+(?:-[a-z]+)?)\s*\(\s*(\d+)\s*\)|(\d+)|([a-z]+(?:-[a-z]+)?))[\s-]*(?:(business|working|calendar)\s+)?(day|week|month|year)s?\b/g;

/** The first duration in wording such as "ten (10) business days", as (number, unit). */
export function canonicalDuration(text: string): CanonicalDuration | null {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-");
  if (/\bmonth[\s-]to[\s-]month\b/.test(normalized)) return [1, "month"];
  if (/\byear[\s-]to[\s-]year\b/.test(normalized)) return [12, "month"];
  for (const match of normalized.matchAll(DURATION_PATTERN)) {
    const [, , parenthesized, digits, spelled, qualifier, unit] = match;
    const numeral = parenthesized ?? digits;
    const value =
      numeral !== undefined ? Number(numeral) : wordNumber(spelled!);
    if (value === null || !Number.isSafeInteger(value)) continue;
    const business = qualifier === "business" || qualifier === "working";
    return canonicalUnit(
      value,
      business && unit === "day" ? "business_day" : (unit as DurationUnit),
    );
  }
  return null;
}

const sameDuration = (
  a: CanonicalDuration | null,
  b: CanonicalDuration | null,
) => Boolean(a && b && a[0] === b[0] && a[1] === b[1]);

// --- Fields ----------------------------------------------------------------------------------

/** Known/unknown gold against an asserted value or an abstention. */
export function classifyField(
  goldKnown: boolean,
  predictedKnown: boolean,
  same: boolean,
): Exclude<FieldOutcome, "no_result"> {
  if (goldKnown && predictedKnown) return same ? "correct" : "wrong";
  if (goldKnown) return "false_abstention";
  return predictedKnown ? "fabricated" : "correct_abstention";
}

export type FieldScore = {
  gold: unknown;
  predicted: unknown;
  outcome: FieldOutcome;
};

function scoreField(
  path: FieldPath,
  gold: unknown,
  stored: JsonRecord | null,
): FieldScore {
  if (!stored) return { gold, predicted: null, outcome: "no_result" };
  const raw = readPath(stored, path) ?? null;

  if (path === "summary.renewal.auto_renew") {
    const predicted = typeof raw === "boolean" ? raw : null;
    return {
      gold,
      predicted: raw,
      outcome: classifyField(
        gold !== null,
        predicted !== null,
        predicted === gold,
      ),
    };
  }
  if (path === "summary.cancellation.notice_period_days") {
    const predicted = typeof raw === "number" ? raw : null;
    return {
      gold,
      predicted: raw,
      outcome: classifyField(
        gold !== null,
        predicted !== null,
        predicted === gold,
      ),
    };
  }
  // Duration wording: placeholders such as "Not specified" count as abstaining.
  const text = typeof raw === "string" && isSubstantiveText(raw) ? raw : null;
  const goldCanon =
    gold === null
      ? null
      : canonicalUnit(...(gold as { canon: [number, DurationUnit] }).canon);
  return {
    gold,
    predicted: raw,
    outcome: classifyField(
      goldCanon !== null,
      text !== null,
      sameDuration(goldCanon, text === null ? null : canonicalDuration(text)),
    ),
  };
}

// --- Quotations ------------------------------------------------------------------------------

const SEGMENT_MARKER =
  /Contract segment: (?:full|section-\d+) \(Unicode code points/;

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + 1)
  ) {
    count += 1;
  }
  return count;
}

const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();
const TYPOGRAPHY: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
];
// Typography covers quotation marks, dashes, ellipses, and letter case.
const typographic = (value: string) =>
  collapseWhitespace(
    TYPOGRAPHY.reduce(
      (text, [pattern, plain]) => text.replace(pattern, plain),
      value,
    ),
  ).toLowerCase();
const DRIFTS: Array<[QuoteDiagnosis, (value: string) => string]> = [
  ["whitespace_drift", collapseWhitespace],
  ["typography_drift", typographic],
  ["unicode_drift", (value) => typographic(value.normalize("NFKC"))],
];

const words = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

function nearMiss(
  quote: string,
  segments: readonly ContractSegment[],
): boolean {
  const needle = words(quote);
  if (needle.length < 3) return false;
  const wanted = new Map<string, number>();
  for (const word of needle) wanted.set(word, (wanted.get(word) ?? 0) + 1);
  return segments.some((segment) => {
    const haystack = words(segment.text);
    for (
      let start = 0;
      start <= Math.max(0, haystack.length - needle.length);
      start += 1
    ) {
      const have = new Map<string, number>();
      for (const word of haystack.slice(start, start + needle.length)) {
        have.set(word, (have.get(word) ?? 0) + 1);
      }
      let shared = 0;
      for (const [word, count] of wanted)
        shared += Math.min(count, have.get(word) ?? 0);
      if (shared / needle.length >= NEAR_MISS_THRESHOLD) return true;
    }
    return false;
  });
}

/**
 * Why a proposed quotation failed production verification. Diagnosis is evaluation-only: it
 * explains failures and never loosens the exact, unique, segment-bounded production match.
 */
export function diagnoseQuote(
  evidence: { quote: string; segment: string },
  source: {
    text: string;
    segments: readonly ContractSegment[];
    contextTexts: readonly string[];
    prompt?: string | null;
  },
): QuoteDiagnosis {
  const { quote, segment: label } = evidence;
  if (!quote.trim()) return "fabricated";
  if (Array.from(quote).length > MAX_EVIDENCE_QUOTE) return "too_long";
  const labelled = source.segments.find((segment) => segment.label === label);
  if (labelled && occurrences(labelled.text, quote) > 1) return "ambiguous";
  if (
    source.segments.some(
      (segment) =>
        segment.label !== label &&
        verifyQuote({ quote, segment: segment.label }, source.segments),
    )
  ) {
    return "wrong_segment";
  }
  if (source.segments.some((segment) => occurrences(segment.text, quote) > 1)) {
    return "ambiguous";
  }
  // Contract text, but not inside any one segment: it runs across a section boundary.
  if (source.text.includes(quote)) return "cross_section";
  if (SEGMENT_MARKER.test(quote)) return "segment_marker";
  if (source.contextTexts.some((text) => text.includes(quote)))
    return "quoted_context";
  if (source.prompt?.includes(quote)) return "quoted_prompt";
  for (const [diagnosis, normalize] of DRIFTS) {
    const needle = normalize(quote);
    if (
      source.segments.some((segment) =>
        normalize(segment.text).includes(needle),
      )
    ) {
      return diagnosis;
    }
  }
  return nearMiss(quote, source.segments) ? "near_miss" : "fabricated";
}

// --- Case scoring ----------------------------------------------------------------------------

export type CaseScore = {
  caseId: string;
  clauses: {
    required: number;
    found: number;
    recall: number | null;
    labelled: number;
    labelRecall: number | null;
    byCategory: Partial<
      Record<ClauseCategory, { required: number; found: number }>
    >;
  };
  spans: { quoted: number; inside: number; precision: number | null };
  quotes: {
    flags: number;
    withEvidence: number;
    verified: number;
    evidenceRate: number | null;
    verificationRate: number | null;
    diagnoses: Partial<Record<QuoteDiagnosis, number>>;
    failures: Array<{ flag: number; diagnosis: QuoteDiagnosis; quote: string }>;
  };
  fields: Partial<Record<FieldPath, FieldScore>>;
  autoRenew: {
    gold: boolean | null;
    predicted: boolean | null;
    critical: boolean;
  } | null;
  negatives: {
    falseFlags: Array<{
      flag: number;
      type: string;
      categories: ClauseCategory[];
    }>;
    benignAlarms: number | null;
  };
  jurisdiction: {
    /** The stored proposal against the gold governing-law clause; null when the case does not score it. */
    outcome: FieldOutcome | null;
    /** 1 when the model proposed a jurisdiction whose quotation production could not verify. */
    unverified: number;
  };
  comparisons: {
    /** Regional comparisons in the model's answer. No case confirms a jurisdiction to support one. */
    proposed: number;
    /** The stored report carries the server's withheld flag and none of those comparisons. */
    withheld: boolean;
  };
  dates: {
    required: number;
    matched: number;
    recall: number | null;
    unsupported: string[];
    typeMismatches: number;
  };
  parties: {
    gold: number;
    matched: number;
    recall: number | null;
    unmatchedPredicted: string[];
  };
  parsePath: ParsePath;
  coverage: { expected: string[]; reported: boolean };
};

function overlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function mergeIntervals(clauses: readonly LocatedClause[]) {
  const sorted = [...clauses].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const { start, end } of sorted) {
    const last = merged.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

type EvalCaseParty = LoadedCase["spec"]["parties"][number];

const isoDate = (value: unknown) =>
  typeof value === "string"
    ? (value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null)
    : null;

/**
 * A stored proposal is correct when its verified citation lies mostly inside the gold clause and it
 * names the gold jurisdiction. Production stores none without a verified citation.
 */
function scoreJurisdiction(
  loaded: LoadedCase,
  run: RunOutput,
): CaseScore["jurisdiction"] {
  const stored = run.stored;
  const proposed = run.analysis?.proposed_jurisdiction;
  const citation = stored
    ? citationForReport(stored, loaded.contractId, JURISDICTION_CITATION)
    : null;
  const unverified = stored && proposed && !citation ? 1 : 0;
  const gold = loaded.governingLaw;
  if (gold === undefined) return { outcome: null, unverified };
  if (!stored) return { outcome: "no_result", unverified };
  const predicted = asRecord(stored.proposed_jurisdiction)?.jurisdiction;
  if (!citation || typeof predicted !== "string") {
    return {
      outcome: gold ? "false_abstention" : "correct_abstention",
      unverified,
    };
  }
  if (!gold) return { outcome: "fabricated", unverified };
  const names = ` ${normalizeLabel(predicted)} `.includes(
    ` ${normalizeLabel(gold.jurisdiction)} `,
  );
  const inside =
    overlap(citation, gold) / (citation.end - citation.start) >=
    CLAUSE_OVERLAP_THRESHOLD;
  return { outcome: names && inside ? "correct" : "wrong", unverified };
}

export function scoreCase(loaded: LoadedCase, run: RunOutput): CaseScore {
  const { spec } = loaded;
  const stored = run.stored;
  const flags = (Array.isArray(stored?.red_flags) ? stored.red_flags : []).map(
    (flag) => asRecord(flag) ?? {},
  );
  const proposals = run.analysis?.red_flags ?? [];
  const citations = flags.map((_, index) =>
    stored ? citationForReport(stored, loaded.contractId, index) : null,
  );
  const verified = citations.filter(
    (citation): citation is SourceCitation => citation !== null,
  );
  const flagCategories = flags.map((flag) =>
    resolveCategories(typeof flag.type === "string" ? flag.type : ""),
  );

  const required = loaded.clauses.filter((clause) => clause.required);
  const byCategory: CaseScore["clauses"]["byCategory"] = {};
  let found = 0;
  let labelled = 0;
  for (const clause of required) {
    const hit = verified.some(
      (citation) =>
        overlap(citation, clause) / (citation.end - citation.start) >=
        CLAUSE_OVERLAP_THRESHOLD,
    );
    const tally = (byCategory[clause.category] ??= { required: 0, found: 0 });
    tally.required += 1;
    if (hit) {
      found += 1;
      tally.found += 1;
    }
    if (
      flagCategories.some((categories) => categories.includes(clause.category))
    ) {
      labelled += 1;
    }
  }

  const gold = mergeIntervals(loaded.clauses);
  const quoted = verified.reduce(
    (sum, citation) => sum + citation.end - citation.start,
    0,
  );
  const inside = verified.reduce(
    (sum, citation) =>
      sum +
      gold.reduce(
        (covered, interval) => covered + overlap(citation, interval),
        0,
      ),
    0,
  );

  const failures: CaseScore["quotes"]["failures"] = [];
  let withEvidence = 0;
  for (const [index, proposal] of proposals.entries()) {
    const evidence = proposal.evidence;
    if (!evidence) continue;
    withEvidence += 1;
    if (citations[index]) continue;
    failures.push({
      flag: index,
      quote: evidence.quote,
      diagnosis: diagnoseQuote(evidence, {
        text: loaded.text,
        segments: loaded.segments,
        contextTexts: loaded.context.map((document) => document.text),
        prompt: run.prompt,
      }),
    });
  }
  const diagnoses: CaseScore["quotes"]["diagnoses"] = {};
  for (const { diagnosis } of failures)
    diagnoses[diagnosis] = (diagnoses[diagnosis] ?? 0) + 1;

  const fields: CaseScore["fields"] = {};
  for (const [path, value] of Object.entries(spec.fields) as Array<
    [FieldPath, unknown]
  >) {
    if (value !== undefined) fields[path] = scoreField(path, value, stored);
  }
  const renewal = fields["summary.renewal.auto_renew"];
  const autoRenew =
    renewal && renewal.outcome !== "no_result"
      ? {
          gold: renewal.gold as boolean | null,
          predicted:
            typeof renewal.predicted === "boolean" ? renewal.predicted : null,
          critical: renewal.gold === null && renewal.predicted === false,
        }
      : null;

  const falseFlags = flags.flatMap((flag, index) => {
    const categories = flagCategories[index]!.filter((category) =>
      spec.absent.includes(category),
    );
    return categories.length
      ? [{ flag: index, type: String(flag.type), categories }]
      : [];
  });
  const benignAlarms = spec.benign
    ? flags.filter(
        (flag) =>
          typeof flag.severity === "number" && flag.severity >= HIGH_SEVERITY,
      ).length + (stored?.risk_badge === "HIGH" ? 1 : 0)
    : null;

  const predictedDates = (
    Array.isArray(stored?.key_dates) ? stored.key_dates : []
  )
    .map((entry) => ({
      type: asRecord(entry)?.type,
      date: isoDate(asRecord(entry)?.date),
    }))
    .filter(
      (entry): entry is { type: unknown; date: string } => entry.date !== null,
    );
  const requiredDates = spec.key_dates.filter((date) => date.required);
  const matchedDates = requiredDates.filter((date) =>
    predictedDates.some((predicted) => predicted.date === date.date),
  );
  const unsupported = [
    ...new Set(
      predictedDates
        .map((predicted) => predicted.date)
        .filter(
          (date) => !spec.key_dates.some((goldDate) => goldDate.date === date),
        ),
    ),
  ];
  const typeMismatches = matchedDates.filter(
    (date) =>
      !predictedDates.some(
        (predicted) =>
          predicted.date === date.date && predicted.type === date.type,
      ),
  ).length;

  const predictedParties = (
    Array.isArray(stored?.parties) ? stored.parties : []
  )
    .filter((party): party is string => typeof party === "string")
    .map((party) => ({ party, normalized: ` ${normalizeLabel(party)} ` }));
  const namesParty = (normalized: string, party: EvalCaseParty) =>
    [party.name, ...party.aliases].some((alias) =>
      normalized.includes(` ${normalizeLabel(alias)} `),
    );
  const matchedParties = spec.parties.filter((party) =>
    predictedParties.some(({ normalized }) => namesParty(normalized, party)),
  );

  const reportedNotices = Array.isArray(stored?.coverage_notices)
    ? stored.coverage_notices
    : [];
  const storedComparisons = Array.isArray(stored?.normal_in_region)
    ? stored.normal_in_region.length
    : 0;

  return {
    caseId: spec.id,
    clauses: {
      required: required.length,
      found,
      recall: ratio(found, required.length),
      labelled,
      labelRecall: ratio(labelled, required.length),
      byCategory,
    },
    spans: { quoted, inside, precision: ratio(inside, quoted) },
    quotes: {
      flags: flags.length,
      withEvidence,
      verified: verified.length,
      evidenceRate: ratio(withEvidence, flags.length),
      verificationRate: ratio(verified.length, withEvidence),
      diagnoses,
      failures,
    },
    fields,
    autoRenew,
    negatives: { falseFlags, benignAlarms },
    jurisdiction: scoreJurisdiction(loaded, run),
    comparisons: {
      proposed: run.analysis?.normal_in_region.length ?? 0,
      withheld:
        stored?.comparisons_withheld === true && storedComparisons === 0,
    },
    dates: {
      required: requiredDates.length,
      matched: matchedDates.length,
      recall: ratio(matchedDates.length, requiredDates.length),
      unsupported,
      typeMismatches,
    },
    parties: {
      gold: spec.parties.length,
      matched: matchedParties.length,
      recall: ratio(matchedParties.length, spec.parties.length),
      unmatchedPredicted: predictedParties
        .filter(
          ({ normalized }) =>
            !spec.parties.some((party) => namesParty(normalized, party)),
        )
        .map(({ party }) => party),
    },
    parsePath: run.parsePath,
    coverage: {
      expected: loaded.expectedCoverageNotices,
      reported:
        stored !== null &&
        loaded.expectedCoverageNotices.every((notice) =>
          reportedNotices.includes(notice),
        ),
    },
  };
}

// --- Metrics ---------------------------------------------------------------------------------

/** The scored values of one case, flattened so changes and imperfections can be compared. */
export function caseMetrics(score: CaseScore): CaseMetrics {
  const metrics: CaseMetrics = {
    "clauses.recall": score.clauses.recall,
    "labels.recall": score.clauses.labelRecall,
    "spans.precision": score.spans.precision,
    "quotes.evidence_rate": score.quotes.evidenceRate,
    "quotes.verification_rate": score.quotes.verificationRate,
    "negatives.false_flags": score.negatives.falseFlags.length,
    "negatives.unsupported_comparisons": score.comparisons.proposed,
    "negatives.unverified_jurisdiction": score.jurisdiction.unverified,
    "comparisons.withheld": score.comparisons.withheld,
    "dates.recall": score.dates.recall,
    "dates.unsupported": score.dates.unsupported.length,
    "parties.recall": score.parties.recall,
    "parse.path": score.parsePath,
    "coverage.notice": score.coverage.reported,
  };
  for (const [category, tally] of Object.entries(score.clauses.byCategory)) {
    metrics[`clauses.category.${category}`] = tally.found / tally.required;
  }
  for (const [diagnosis, count] of Object.entries(score.quotes.diagnoses)) {
    metrics[`quotes.diagnosis.${diagnosis}`] = count;
  }
  for (const [path, field] of Object.entries(score.fields)) {
    metrics[`fields.${path}`] = field.outcome;
  }
  if (score.autoRenew)
    metrics["auto_renew.critical"] = score.autoRenew.critical ? 1 : 0;
  if (score.jurisdiction.outcome !== null)
    metrics["jurisdiction.proposal"] = score.jurisdiction.outcome;
  if (score.negatives.benignAlarms !== null) {
    metrics["negatives.benign_alarms"] = score.negatives.benignAlarms;
  }
  return metrics;
}

function isIdeal(key: string, value: MetricValue): boolean {
  if (key.startsWith("fields.") || key === "jurisdiction.proposal")
    return value === "correct" || value === "correct_abstention";
  if (
    key.startsWith("quotes.diagnosis.") ||
    key.startsWith("negatives.") ||
    key === "auto_renew.critical" ||
    key === "dates.unsupported"
  ) {
    return value === 0;
  }
  if (key === "parse.path") return value === "strict";
  if (key === "coverage.notice" || key === "comparisons.withheld")
    return value === true;
  if (
    key.startsWith("clauses.") ||
    /^(?:labels|spans|quotes|dates|parties)\.(?:recall|precision|evidence_rate|verification_rate)$/.test(
      key,
    )
  ) {
    // null means the measure does not apply to this case.
    return value === 1 || value === null;
  }
  throw new Error(`No ideal value is defined for metric ${key}`);
}

/** Metrics that differ from their ideal value; a perfect answer yields {}. */
export function imperfections(metrics: CaseMetrics): CaseMetrics {
  return Object.fromEntries(
    Object.entries(metrics).filter(([key, value]) => !isIdeal(key, value)),
  );
}

/** Sorted keys whose values differ, including keys present on only one side. */
export function changedMetrics(
  before: CaseMetrics,
  after: CaseMetrics,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
}

// --- Suite summary ---------------------------------------------------------------------------

type ConfusionKey = "true" | "false" | "null";
const confusionKey = (value: boolean | null): ConfusionKey =>
  String(value) as ConfusionKey;

export function summarizeScores(scores: readonly CaseScore[]) {
  const sum = (pick: (score: CaseScore) => number) =>
    scores.reduce((total, score) => total + pick(score), 0);
  const byCategory: Partial<
    Record<ClauseCategory, { required: number; found: number }>
  > = {};
  const diagnoses: Partial<Record<QuoteDiagnosis, number>> = {};
  const fields: Partial<
    Record<FieldPath, Partial<Record<FieldOutcome, number>>>
  > = {};
  const parsePaths: Partial<Record<ParsePath, number>> = {};
  const jurisdiction: Partial<Record<FieldOutcome, number>> = {};
  const autoRenewConfusion = Object.fromEntries(
    (["true", "false", "null"] as const).map((gold) => [
      gold,
      { true: 0, false: 0, null: 0 },
    ]),
  ) as Record<ConfusionKey, Record<ConfusionKey, number>>;

  for (const score of scores) {
    for (const [category, tally] of Object.entries(
      score.clauses.byCategory,
    ) as Array<[ClauseCategory, { required: number; found: number }]>) {
      const total = (byCategory[category] ??= { required: 0, found: 0 });
      total.required += tally.required;
      total.found += tally.found;
    }
    for (const [diagnosis, count] of Object.entries(
      score.quotes.diagnoses,
    ) as Array<[QuoteDiagnosis, number]>) {
      diagnoses[diagnosis] = (diagnoses[diagnosis] ?? 0) + count;
    }
    for (const [path, field] of Object.entries(score.fields) as Array<
      [FieldPath, FieldScore]
    >) {
      const outcomes = (fields[path] ??= {});
      outcomes[field.outcome] = (outcomes[field.outcome] ?? 0) + 1;
    }
    parsePaths[score.parsePath] = (parsePaths[score.parsePath] ?? 0) + 1;
    const proposal = score.jurisdiction.outcome;
    if (proposal) jurisdiction[proposal] = (jurisdiction[proposal] ?? 0) + 1;
    if (score.autoRenew) {
      autoRenewConfusion[confusionKey(score.autoRenew.gold)][
        confusionKey(score.autoRenew.predicted)
      ] += 1;
    }
  }

  return {
    cases: scores.length,
    clauseRecall: ratio(
      sum((s) => s.clauses.found),
      sum((s) => s.clauses.required),
    ),
    labelRecall: ratio(
      sum((s) => s.clauses.labelled),
      sum((s) => s.clauses.required),
    ),
    byCategory,
    spanPrecision: ratio(
      sum((s) => s.spans.inside),
      sum((s) => s.spans.quoted),
    ),
    quotes: {
      flags: sum((s) => s.quotes.flags),
      withEvidence: sum((s) => s.quotes.withEvidence),
      verified: sum((s) => s.quotes.verified),
      evidenceRate: ratio(
        sum((s) => s.quotes.withEvidence),
        sum((s) => s.quotes.flags),
      ),
      verificationRate: ratio(
        sum((s) => s.quotes.verified),
        sum((s) => s.quotes.withEvidence),
      ),
      diagnoses,
    },
    fields,
    /** Rows are gold values, columns predictions; gold null predicted false is the critical error. */
    autoRenewConfusion,
    criticalErrors: autoRenewConfusion.null.false,
    falseFlags: sum((s) => s.negatives.falseFlags.length),
    benignAlarms: sum((s) => s.negatives.benignAlarms ?? 0),
    unsupportedComparisons: sum((s) => s.comparisons.proposed),
    /** Stored jurisdiction proposals by outcome, for cases that score one. */
    jurisdiction,
    /** Proposals dropped because their governing-law quotation did not verify. */
    unverifiedJurisdictions: sum((s) => s.jurisdiction.unverified),
    /** Cases whose stored report withheld comparisons, as every case without a jurisdiction must. */
    comparisonsWithheld: scores.filter((s) => s.comparisons.withheld).length,
    dateRecall: ratio(
      sum((s) => s.dates.matched),
      sum((s) => s.dates.required),
    ),
    unsupportedDates: sum((s) => s.dates.unsupported.length),
    partyRecall: ratio(
      sum((s) => s.parties.matched),
      sum((s) => s.parties.gold),
    ),
    parsePaths,
  };
}
