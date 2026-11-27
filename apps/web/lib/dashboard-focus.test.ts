import { describe, expect, it } from "vitest";
import { dashboardFocusFromSearchParams } from "@/lib/dashboard-focus";

const CONTRACT = "33333333-3333-4333-8333-333333333333";
const ANALYSIS = "44444444-4444-4444-8444-444444444444";
const THREAD = "55555555-5555-4555-8555-555555555555";

describe("dashboardFocusFromSearchParams", () => {
  it("keeps a contract id, an analysis id and a key from the grammar", () => {
    expect(
      dashboardFocusFromSearchParams({
        contract: CONTRACT.toUpperCase(),
        analysis: ANALYSIS.toUpperCase(),
        ask: "finding-2",
      }),
    ).toEqual({
      focusContractId: CONTRACT,
      focusAsk: { analysisId: ANALYSIS, itemKey: "finding-2" },
    });
  });

  it("keeps only the contract when the analysis id or the key is malformed or missing", () => {
    for (const params of [
      { analysis: "not-a-uuid", ask: "finding-2" },
      { analysis: ANALYSIS, ask: "Auto-renewal trap" },
      { analysis: ANALYSIS, ask: "finding-0" },
      { analysis: ANALYSIS },
      { ask: "question-1" },
      {},
    ])
      expect(
        dashboardFocusFromSearchParams({ contract: CONTRACT, ...params }),
        JSON.stringify(params),
      ).toEqual({ focusContractId: CONTRACT });
  });

  it("drops everything without a valid contract id", () => {
    expect(dashboardFocusFromSearchParams(undefined)).toEqual({});
    expect(
      dashboardFocusFromSearchParams({ contract: "x", analysis: ANALYSIS, ask: "question-1" }),
    ).toEqual({});
  });

  it("opens a saved thread by id, ahead of a contract, an analysis and a key", () => {
    expect(dashboardFocusFromSearchParams({ thread: THREAD.toUpperCase() })).toEqual({
      focusThreadId: THREAD,
    });
    expect(
      dashboardFocusFromSearchParams({
        thread: [THREAD, "x"],
        contract: CONTRACT,
        analysis: ANALYSIS,
        ask: "finding-2",
      }),
    ).toEqual({ focusThreadId: THREAD });
  });

  it("drops a malformed thread id like a malformed contract id", () => {
    for (const thread of ["x", "", `${THREAD}x`, "../contracts"])
      expect(dashboardFocusFromSearchParams({ thread }), thread).toEqual({});
    expect(
      dashboardFocusFromSearchParams({ thread: "x", contract: CONTRACT }),
    ).toEqual({ focusContractId: CONTRACT });
  });

  it("reads the first value of a repeated parameter", () => {
    expect(
      dashboardFocusFromSearchParams({
        contract: [CONTRACT, "x"],
        analysis: [ANALYSIS],
        ask: ["question-1", "finding-1"],
      }),
    ).toEqual({
      focusContractId: CONTRACT,
      focusAsk: { analysisId: ANALYSIS, itemKey: "question-1" },
    });
  });
});
