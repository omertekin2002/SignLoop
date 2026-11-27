import { describe, expect, it } from "vitest";
import {
  CLARIFY_DECISION_KEY_MAX_CHARACTERS,
  CLARIFY_DECISION_LABEL_MAX_CHARACTERS,
  CLARIFY_DECISION_REASON_MAX_CHARACTERS,
  clarifyItemKeyStatus,
  parseClarifyDecisionDelete,
  parseClarifyDecisionSave,
} from "@/lib/clarify-decisions";
import { questionDecisionKey, unstatedDecisionKey } from "@/lib/clarify-keys";
import { CONTRACT_ID, storedAnalysis } from "@/lib/fixtures/clarify-analysis";

const ANALYSIS_ID = "22222222-3333-4444-8555-666666666666";
const valid = {
  analysisId: ANALYSIS_ID,
  itemKey: "v1:unstated:term",
  state: "accepted",
  reason: "Monthly is fine.",
  itemLabel: "Term: Not specified",
  expectedUpdatedAt: null,
};

describe("parseClarifyDecisionSave", () => {
  it("accepts a well-formed save, new or against a revision", () => {
    expect(parseClarifyDecisionSave(valid)).toEqual(valid);
    const update = { ...valid, expectedUpdatedAt: "2026-11-27T09:00:00.123+03:00" };
    expect(parseClarifyDecisionSave(update)).toEqual(update);
    for (const state of ["resolved", "accepted", "open"]) {
      expect(parseClarifyDecisionSave({ ...valid, state })).not.toBeNull();
    }
    expect(parseClarifyDecisionSave({ ...valid, reason: "" })).not.toBeNull();
  });

  it("counts the reason and label limits in code points, as PostgreSQL's char_length does", () => {
    // Each emoji is two UTF-16 code units but one code point.
    const reason = "😀".repeat(CLARIFY_DECISION_REASON_MAX_CHARACTERS);
    const itemLabel = "😀".repeat(CLARIFY_DECISION_LABEL_MAX_CHARACTERS);
    expect(parseClarifyDecisionSave({ ...valid, reason, itemLabel })).toMatchObject({ reason, itemLabel });
    expect(parseClarifyDecisionSave({ ...valid, reason: `${reason}a` })).toBeNull();
    expect(parseClarifyDecisionSave({ ...valid, itemLabel: `${itemLabel}a` })).toBeNull();
  });

  it.each([
    ["a NUL in the reason", { ...valid, reason: "a\u0000b" }],
    ["a NUL in the label", { ...valid, itemLabel: "a\u0000b" }],
    ["an empty label", { ...valid, itemLabel: "  " }],
    ["a source revision from the client", { ...valid, sourceRevision: `sha256:${"a".repeat(64)}` }],
    ["an unknown field", { ...valid, userId: "intruder" }],
    ["a bad state", { ...valid, state: "ignored" }],
    ["a missing state", { ...valid, state: undefined }],
    ["a malformed analysis id", { ...valid, analysisId: "not-a-uuid" }],
    ["a key that is not a clarify key", { ...valid, itemKey: "finding 3" }],
    ["an over-long key", { ...valid, itemKey: `v1:question:${"a".repeat(CLARIFY_DECISION_KEY_MAX_CHARACTERS)}` }],
    ["a missing expectedUpdatedAt", { ...valid, expectedUpdatedAt: undefined }],
    ["an expectedUpdatedAt that is not a timestamp", { ...valid, expectedUpdatedAt: "yesterday" }],
    ["a non-object body", "decision"],
    ["no body", null],
  ])("refuses %s", (_label, body) => {
    expect(parseClarifyDecisionSave(body)).toBeNull();
  });
});

describe("parseClarifyDecisionDelete", () => {
  it("needs exactly a timestamp revision", () => {
    const body = { expectedUpdatedAt: "2026-11-27T09:00:00.123Z" };
    expect(parseClarifyDecisionDelete(body)).toEqual(body);
    expect(parseClarifyDecisionDelete({ expectedUpdatedAt: null })).toBeNull();
    expect(parseClarifyDecisionDelete({})).toBeNull();
    expect(parseClarifyDecisionDelete({ ...body, id: "x" })).toBeNull();
    expect(parseClarifyDecisionDelete(null)).toBeNull();
  });
});

describe("clarifyItemKeyStatus", () => {
  it("accepts a key that names one item of the analysis's checklist", () => {
    const result = storedAnalysis();
    expect(clarifyItemKeyStatus(CONTRACT_ID, result, unstatedDecisionKey("Term"))).toBe("ok");
    expect(
      clarifyItemKeyStatus(CONTRACT_ID, result, questionDecisionKey("How much is the early exit fee?")),
    ).toBe("ok");
  });

  it("refuses a key the checklist does not list, including a quoted fact's", () => {
    const result = storedAnalysis();
    expect(clarifyItemKeyStatus(CONTRACT_ID, result, questionDecisionKey("Something else?"))).toBe("unknown");
    // Renewal is quoted in the fixture, so it is not on the list.
    expect(clarifyItemKeyStatus(CONTRACT_ID, result, unstatedDecisionKey("Renewal"))).toBe("unknown");
    // An empty analysis lists every singular fact as not stated, and nothing else.
    expect(clarifyItemKeyStatus(CONTRACT_ID, null, unstatedDecisionKey("Term"))).toBe("ok");
    expect(
      clarifyItemKeyStatus(CONTRACT_ID, null, questionDecisionKey("How much is the early exit fee?")),
    ).toBe("unknown");
  });

  it("refuses a key that names more than one item", () => {
    const result = storedAnalysis();
    const question = "Can the renewal be switched off?";
    result.next_actions = { questions_to_ask: [question, question], email_templates: [] };
    expect(clarifyItemKeyStatus(CONTRACT_ID, result, questionDecisionKey(question))).toBe("ambiguous");
  });
});
