import { describe, expect, it } from "vitest";
import { contractSourceRevision } from "@/lib/analysis-sources";
import { SourceIdentitySchema } from "@/lib/source-citations";
import {
  applyPatch,
  evalContractId,
  fixtureFiles,
  loadCases,
  loadOracles,
  loadPerturbations,
  locateGoldSpan,
  readFixture,
} from "./dataset";
import { findPii } from "./pii";
import { CLAUSE_CATEGORIES, resolveCategories, TAXONOMY } from "./taxonomy";

const cases = loadCases();

describe("evaluation cases", () => {
  it("locate every gold span exactly once, at production code point offsets", () => {
    expect(cases).toHaveLength(9);
    for (const loaded of cases) {
      const codePoints = Array.from(loaded.text);
      for (const clause of loaded.clauses) {
        expect(codePoints.slice(clause.start, clause.end).join("")).toBe(
          clause.span,
        );
      }
      const law = loaded.spec.governing_law;
      if (law) {
        expect(
          codePoints
            .slice(loaded.governingLaw!.start, loaded.governingLaw!.end)
            .join(""),
        ).toBe(law.span);
      }
    }
  });

  it("cover contracts with and without a governing-law clause", () => {
    expect(cases.filter((loaded) => loaded.governingLaw).length).toBeGreaterThan(0);
    for (const loaded of cases.filter((item) => item.governingLaw === null)) {
      expect(loaded.text).not.toMatch(/govern(?:ed|ing) by|governing law/i);
    }
    expect(cases.some((loaded) => loaded.governingLaw === null)).toBe(true);
  });

  it("place omitted spans wholly in the unsent middle of a long contract", () => {
    const omitted = cases.flatMap((loaded) =>
      loaded.clauses
        .filter((clause) => clause.location === "omitted")
        .map((clause) => ({ loaded, clause })),
    );
    expect(omitted.length).toBeGreaterThan(0);
    for (const { loaded, clause } of omitted) {
      const [head, tail] = loaded.segments;
      expect(loaded.segments.map((segment) => segment.label)).toEqual([
        "head",
        "tail",
      ]);
      expect(clause.start).toBeGreaterThanOrEqual(head!.end);
      expect(clause.end).toBeLessThanOrEqual(tail!.start);
      expect(loaded.expectedCoverageNotices.join(" ")).toMatch(
        /middle characters were omitted/,
      );
    }
  });

  it("include tail-segment gold spans with absolute offsets", () => {
    const tail = cases.flatMap((loaded) =>
      loaded.clauses.filter((clause) => clause.location === "tail"),
    );
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((clause) => clause.start > 9750)).toBe(true);
  });

  it("derive distinct contract IDs that production source receipts accept", () => {
    expect(evalContractId("gym-autorenew-01")).toBe(
      evalContractId("gym-autorenew-01"),
    );
    expect(new Set(cases.map((loaded) => loaded.contractId)).size).toBe(
      cases.length,
    );
    for (const loaded of cases) {
      expect(
        SourceIdentitySchema.safeParse({
          contract_id: loaded.contractId,
          revision: contractSourceRevision(loaded.text),
          index_unit: "unicode-code-points",
        }).success,
      ).toBe(true);
    }
  });

  it("pair every case with one oracle, and every perturbation with an oracle path", () => {
    const oracles = loadOracles();
    expect(oracles.map((oracle) => oracle.case)).toEqual(
      cases.map((loaded) => loaded.spec.id),
    );
    const perturbations = loadPerturbations();
    expect(perturbations).toHaveLength(7);
    for (const perturbation of perturbations) {
      const oracle = oracles.find(
        (candidate) => candidate.case === perturbation.case,
      );
      expect(oracle).toBeDefined();
      expect(applyPatch(oracle!.output, perturbation.patch)).not.toEqual(
        oracle!.output,
      );
    }
  });
});

describe("gold span location", () => {
  const filler = (length: number) => "x".repeat(length);
  const long = [
    filler(9740),
    "BOUNDARY CLAUSE",
    filler(3000),
    "MIDDLE CLAUSE",
    filler(6000),
    "TAIL CLAUSE",
  ].join("");
  const short =
    "Fees renew yearly. Fees renew yearly. Notice must be in writing.";

  it("rejects missing and repeated spans", () => {
    expect(locateGoldSpan(short, "Late fees apply")).toMatchObject({
      ok: false,
      problem: "missing",
    });
    expect(locateGoldSpan(short, "Fees renew yearly.")).toMatchObject({
      ok: false,
      problem: "repeated",
    });
  });

  it("rejects spans outside their declared or any sent segment", () => {
    expect(locateGoldSpan(short, "Notice must be", "head")).toMatchObject({
      ok: false,
      problem: "out_of_segment",
    });
    expect(locateGoldSpan(long, "BOUNDARY CLAUSE")).toMatchObject({
      ok: false,
      problem: "out_of_segment",
    });
    expect(locateGoldSpan(long, "MIDDLE CLAUSE")).toMatchObject({
      ok: false,
      problem: "out_of_segment",
    });
    expect(locateGoldSpan(long, "TAIL CLAUSE", "head")).toMatchObject({
      ok: false,
      problem: "out_of_segment",
    });
  });

  it("asserts that omitted spans are unreachable", () => {
    expect(locateGoldSpan(long, "MIDDLE CLAUSE", "omitted")).toMatchObject({
      ok: true,
      location: "omitted",
    });
    expect(locateGoldSpan(short, "Notice must be", "omitted")).toMatchObject({
      ok: false,
      problem: "reachable",
    });
    expect(locateGoldSpan(long, "BOUNDARY CLAUSE", "omitted")).toMatchObject({
      ok: false,
      problem: "reachable",
    });
    expect(locateGoldSpan(long, "TAIL CLAUSE")).toMatchObject({
      ok: true,
      location: "tail",
    });
  });

  it("patches only existing JSON pointer paths", () => {
    expect(
      applyPatch({ a: [{ b: 1 }] }, [{ path: "/a/0/b", value: 2 }]),
    ).toEqual({
      a: [{ b: 2 }],
    });
    expect(() =>
      applyPatch({ a: { b: 1 } }, [{ path: "/a/c", value: 2 }]),
    ).toThrow(/does not exist/);
  });
});

describe("fixture privacy", () => {
  it("keeps contracts, cases, and oracle outputs free of personal data", () => {
    const findings = fixtureFiles().flatMap((file) =>
      findPii(readFixture(file)).map(
        (finding) => `${file}: ${finding.kind} ${finding.match}`,
      ),
    );
    expect(fixtureFiles().length).toBeGreaterThan(20);
    expect(findings).toEqual([]);
  });

  it.each([
    ["email", "Write to alex@acme-legal.com today."],
    ["card", "Card 4111 1111 1111 1111 on file."],
    ["iban", "Pay GB82 WEST 1234 5698 7654 32 monthly."],
    ["ssn", "SSN 123-45-6789."],
    ["phone", "Call (123) 456-7890."],
    ["phone", "Call 555-1212."],
    ["phone", "Call +44 20 7946 0958."],
  ])("flags a %s", (kind, text) => {
    expect(findPii(text).map((finding) => finding.kind)).toContain(kind);
  });

  it("allows reserved example domains, fictional numbers, and invalid checksums", () => {
    expect(
      findPii(
        [
          "billing@example.com ops@mail.example.org desk@corp.test",
          "(303) 555-0117, 303.555.0199, 555-0100",
          "4111 1111 1111 1112, GB00 WEST 1234 5698 7654 32",
          "Dates 2026-07-01 and amounts $18,000.00 are not personal data.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("clause taxonomy", () => {
  it("defines aliases and a source for every category", () => {
    expect(Object.keys(TAXONOMY).sort()).toEqual([...CLAUSE_CATEGORIES].sort());
    for (const category of CLAUSE_CATEGORIES) {
      expect(TAXONOMY[category].aliases.length).toBeGreaterThan(0);
      expect(TAXONOMY[category].source).not.toBe("");
    }
  });

  it.each([
    ["Automatic renewal", ["auto_renewal"]],
    ["Auto-Renew", ["auto_renewal"]],
    ["Month-to-month continuation", ["auto_renewal"]],
    ["No automatic renewal", []],
    ["Non-renewal notice deadline", ["cancellation_notice"]],
    ["Kill fee on early termination", ["early_termination_fee"]],
    ["No termination fee", []],
    ["Mandatory arbitration and class action waiver", ["arbitration"]],
    ["No liability cap", ["uncapped_liability"]],
    ["Liability cap", ["limitation_of_liability"]],
    ["Annual fee escalator", ["price_increase"]],
    ["Non-solicitation and no-hire restriction", ["non_solicitation"]],
  ])("resolves %j", (label, categories) => {
    expect(resolveCategories(label)).toEqual(categories);
  });
});
