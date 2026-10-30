import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  buildAnalysisPrompt,
  type AnalysisContextDocument,
} from "@/lib/analysis";
import {
  contractAnalysisSegments,
  verifyQuote,
  type ContractSegment,
} from "@/lib/source-citations";
import {
  EvalCaseSchema,
  OracleSchema,
  PerturbationSchema,
  type EvalCase,
  type EvalCaseInput,
  type Oracle,
  type Perturbation,
} from "./case-schema";

export const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));

// getProjectContextForAnalysis clips context documents to 3,000 characters in SQL, which the
// harness bypasses. Fixtures stay within that bound so the prompt matches production.
const MAX_CONTEXT_FIXTURE_CHARACTERS = 3_000;

export type GoldLocation = ContractSegment["label"];

export type LocatedClause = EvalCase["clauses"][number] & {
  /** Unicode code points, end exclusive, like production citations. */
  start: number;
  end: number;
  location: GoldLocation;
};

export type LoadedCase = {
  spec: EvalCase;
  contractId: string;
  text: string;
  segments: ContractSegment[];
  context: AnalysisContextDocument[];
  clauses: LocatedClause[];
  /** The located governing-law clause; null when the contract has none, undefined if unscored. */
  governingLaw?: { jurisdiction: string; start: number; end: number } | null;
  /** Notices production adds for this input; the stored report must keep them. */
  expectedCoverageNotices: string[];
};

export type SpanLocation =
  | { ok: true; start: number; end: number; location: GoldLocation }
  | {
      ok: false;
      problem: "missing" | "repeated" | "out_of_segment";
      detail: string;
    };

/** Contract IDs are part of citations; derive a stable RFC 9562 version-8 UUID per case. */
export function evalContractId(caseId: string): string {
  const hex = createHash("sha256")
    .update(`signloop-eval:${caseId}`)
    .digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A gold span must occur exactly once in the contract and lie wholly inside one segment that
 * production sends (and, when declared, the declared one). Production verification must agree on
 * its offsets. A span across a section boundary cannot be quoted, so it is rejected.
 */
export function locateGoldSpan(
  text: string,
  span: string,
  declared?: GoldLocation,
): SpanLocation {
  const at = text.indexOf(span);
  if (at < 0) {
    return {
      ok: false,
      problem: "missing",
      detail: "not found in the contract",
    };
  }
  if (text.indexOf(span, at + 1) >= 0) {
    return {
      ok: false,
      problem: "repeated",
      detail: "occurs more than once; include disambiguating text",
    };
  }
  const start = Array.from(text.slice(0, at)).length;
  const end = start + Array.from(span).length;
  const segments = contractAnalysisSegments(text);
  const containing = segments.find(
    (segment) => segment.start <= start && end <= segment.end,
  );
  if (!containing) {
    return {
      ok: false,
      problem: "out_of_segment",
      detail: `code points ${start}-${end} are not inside one sent segment`,
    };
  }
  if (declared && declared !== containing.label) {
    return {
      ok: false,
      problem: "out_of_segment",
      detail: `declared ${declared} but lies in ${containing.label}`,
    };
  }
  const verified = verifyQuote(
    { quote: span, segment: containing.label },
    segments,
  );
  if (!verified || verified.start !== start || verified.end !== end) {
    return {
      ok: false,
      problem: "out_of_segment",
      detail: "production quote verification disagrees",
    };
  }
  return { ok: true, start, end, location: containing.label };
}

export function buildLoadedCase(input: {
  spec: EvalCaseInput;
  text: string;
  context?: readonly AnalysisContextDocument[];
}): LoadedCase {
  const spec = EvalCaseSchema.parse(input.spec);
  const context = [...(input.context ?? [])];
  const problems: string[] = [];

  if (!input.text.trim()) problems.push("contract text is empty");
  // Offsets and revisions are byte-exact: a CRLF checkout or BOM would silently shift them.
  if (input.text.includes("\r") || input.text.startsWith("\uFEFF")) {
    problems.push("contract text must use LF line endings without a BOM");
  }
  for (const document of context) {
    if (document.text.length > MAX_CONTEXT_FIXTURE_CHARACTERS) {
      problems.push(
        `context "${document.title}" exceeds ${MAX_CONTEXT_FIXTURE_CHARACTERS} characters`,
      );
    }
  }

  const clauses: LocatedClause[] = [];
  for (const [index, clause] of spec.clauses.entries()) {
    const location = locateGoldSpan(input.text, clause.span, clause.segment);
    if (!location.ok) {
      problems.push(
        `clause ${index} (${clause.category}) ${location.problem}: ${location.detail}`,
      );
      continue;
    }
    clauses.push({
      ...clause,
      start: location.start,
      end: location.end,
      location: location.location,
    });
  }

  let governingLaw: LoadedCase["governingLaw"] = null;
  if (spec.governing_law) {
    const location = locateGoldSpan(input.text, spec.governing_law.span);
    if (location.ok) {
      governingLaw = {
        jurisdiction: spec.governing_law.jurisdiction,
        start: location.start,
        end: location.end,
      };
    } else {
      problems.push(`governing law ${location.problem}: ${location.detail}`);
    }
  }

  if (problems.length) {
    throw new Error(`Case ${spec.id} is invalid:\n- ${problems.join("\n- ")}`);
  }
  return {
    spec,
    contractId: evalContractId(spec.id),
    text: input.text,
    segments: contractAnalysisSegments(input.text),
    context,
    clauses,
    ...(spec.governing_law !== undefined ? { governingLaw } : {}),
    expectedCoverageNotices: buildAnalysisPrompt(input.text, undefined, context)
      .coverageNotices,
  };
}

export function readFixture(relativePath: string): string {
  return readFileSync(path.join(EVALS_DIR, relativePath), "utf8");
}

function parseFixture<T>(schema: z.ZodType<T>, relativePath: string): T {
  const parsed = schema.safeParse(JSON.parse(readFixture(relativePath)));
  if (!parsed.success) {
    throw new Error(
      `${relativePath} is invalid:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function jsonFiles(directory: string): string[] {
  return readdirSync(path.join(EVALS_DIR, directory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${directory}/${name}`);
}

export function loadCases(): LoadedCase[] {
  return jsonFiles("cases").map((file) => {
    const spec = parseFixture(EvalCaseSchema, file);
    if (file !== `cases/${spec.id}.json`) {
      throw new Error(`${file} must be named after its id "${spec.id}"`);
    }
    return buildLoadedCase({
      spec,
      text: readFixture(spec.contract),
      context: spec.context.map((document) => ({
        title: document.title,
        documentType: document.document_type,
        text: readFixture(document.file),
      })),
    });
  });
}

export function loadOracles(): Oracle[] {
  return jsonFiles("oracle").map((file) => {
    const oracle = parseFixture(OracleSchema, file);
    if (file !== `oracle/${oracle.case}.json`) {
      throw new Error(`${file} must be named after its case "${oracle.case}"`);
    }
    return oracle;
  });
}

export function loadPerturbations(): Perturbation[] {
  return jsonFiles("oracle/perturbations").map((file) => {
    const perturbation = parseFixture(PerturbationSchema, file);
    if (file !== `oracle/perturbations/${perturbation.id}.json`) {
      throw new Error(
        `${file} must be named after its id "${perturbation.id}"`,
      );
    }
    return perturbation;
  });
}

/** Replace existing values at RFC 6901 pointers in a copy; a missing path is a fixture error. */
export function applyPatch<T>(document: T, patch: Perturbation["patch"]): T {
  const copy = structuredClone(document);
  for (const { path: pointer, value } of patch) {
    const keys = pointer
      .slice(1)
      .split("/")
      .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = keys.pop()!;
    let parent: unknown = copy;
    for (const key of keys) {
      parent =
        parent !== null && typeof parent === "object"
          ? (parent as Record<string, unknown>)[key]
          : undefined;
    }
    if (parent === null || typeof parent !== "object" || !(last in parent)) {
      throw new Error(`Patch path ${pointer} does not exist`);
    }
    (parent as Record<string, unknown>)[last] = value;
  }
  return copy;
}

/** Every fixture file (contracts, cases, oracles), relative to evals/, for hygiene checks. */
export function fixtureFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(path.join(EVALS_DIR, directory))
      .sort()
      .flatMap((name) => {
        const relative = `${directory}/${name}`;
        return statSync(path.join(EVALS_DIR, relative)).isDirectory()
          ? walk(relative)
          : [relative];
      });
  return ["contracts", "cases", "oracle"].flatMap(walk);
}
