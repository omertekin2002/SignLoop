import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const payload = JSON.stringify({
  risk_badge: "LOW",
  key_points: ["Payment is monthly"],
  summary: {
    renewal: { auto_renew: false },
    cancellation: { how: "Email notice", notice_period_days: 30 },
  },
});

function providerResponse(status: string | undefined, text = payload) {
  return Response.json({
    id: "resp_test",
    object: "response",
    status,
    incomplete_details:
      status === "incomplete" ? { reason: "max_output_tokens" } : null,
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://analysis.test/v1");
  vi.stubEnv("PRIMARY_LLM_API_KEY", "test-primary-key");
  vi.stubEnv("OPENROUTER_API_KEY", "test-fallback-key");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("analysis response completion", () => {
  it.each(["incomplete", "failed", undefined])(
    "rejects status %s without repair or another provider call",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(providerResponse(status));
      vi.stubGlobal("fetch", fetchMock);
      const { analyzeText } = await import("./analysis");

      await expect(analyzeText("Monthly payment agreement")).rejects.toThrow(
        /Analysis response did not complete/,
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects an incomplete repair without sending the contract to fallback", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse("completed", "{"))
      .mockResolvedValueOnce(providerResponse("incomplete"));
    vi.stubGlobal("fetch", fetchMock);
    const { analyzeText } = await import("./analysis");

    await expect(analyzeText("Monthly payment agreement")).rejects.toThrow(
      /Analysis response did not complete.*max_output_tokens/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("accepts completed output (repair: %s)", async (repair) => {
    const fetchMock = vi.fn();
    if (repair) fetchMock.mockResolvedValueOnce(providerResponse("completed", "{"));
    fetchMock.mockResolvedValueOnce(providerResponse("completed"));
    vi.stubGlobal("fetch", fetchMock);
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText("Monthly payment agreement");
    expect(answer.result.key_points).toContain("Payment is monthly");
    expect(answer.provider).toBe("primary-openai-compatible");
    expect(fetchMock).toHaveBeenCalledTimes(repair ? 2 : 1);
  });
});
