// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The checklist is keyed inside React's `useMemo` in the browser, so nothing on the way may reach
// for Node's crypto module.
vi.mock("node:crypto", () => {
  throw new Error("clarify keys must not import node:crypto");
});

import { clarifyBeforeSigning } from "@/lib/analysis-clarify";
import {
  clarifyChecklistKeys,
  matchClarifyDecisions,
} from "@/lib/clarify-keys";
import {
  CONTRACT_ID,
  REVISION,
  storedAnalysis,
} from "@/lib/fixtures/clarify-analysis";
import { PINNED_KEYS } from "@/lib/fixtures/clarify-keys-pinned";

describe("clarify keys in a browser-like environment", () => {
  it("runs synchronously and gives the same keys as Node", () => {
    expect(typeof window).toBe("object");
    const result = storedAnalysis();
    const checklist = clarifyBeforeSigning({
      contractId: CONTRACT_ID,
      resultJson: result,
    });
    const keys = clarifyChecklistKeys(checklist, {
      contractId: CONTRACT_ID,
      resultJson: result,
    });
    expect(keys).not.toBeInstanceOf(Promise);
    expect(keys).toEqual(PINNED_KEYS);

    const decisions = [
      { itemKey: PINNED_KEYS.questions[0]!.key, sourceRevision: REVISION },
    ];
    expect(matchClarifyDecisions(decisions, keys, REVISION).matched.size).toBe(
      1,
    );
  });
});
