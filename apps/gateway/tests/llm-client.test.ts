// Provider-failure metadata and the hardened OpenAI client are tested in packages/chat-engine.
import { describe, expect, it } from "vitest";

import { isEligibleOpenRouterFallback } from "../src/pipeline/llm-client";

describe("isEligibleOpenRouterFallback", () => {
  const withStatus = (status: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("provider failure"), { status, ...extra });

  it("stops on request, credential, and payload failures that another model cannot fix", () => {
    for (const status of [400, 401, 403, 405, 413, 422]) {
      expect(isEligibleOpenRouterFallback(withStatus(status))).toBe(false);
    }
  });

  it("continues on transient, unknown, and model-specific failures", () => {
    for (const status of [404, 408, 429, 500, 502, 503]) {
      expect(isEligibleOpenRouterFallback(withStatus(status))).toBe(true);
    }
    expect(isEligibleOpenRouterFallback(new Error("socket hang up"))).toBe(
      true,
    );
    expect(
      isEligibleOpenRouterFallback(
        withStatus(400, { code: "model_not_found" }),
      ),
    ).toBe(true);
    expect(
      isEligibleOpenRouterFallback(
        withStatus(400, { error: { code: "model_not_available" } }),
      ),
    ).toBe(true);
  });
});
