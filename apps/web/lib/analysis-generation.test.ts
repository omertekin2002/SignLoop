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
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    object: "response",
    status,
    incomplete_details:
      status === "incomplete" ? { reason: "max_output_tokens" } : null,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
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
  it("merges provider and input-coverage notices without losing or repeating either", async () => {
    const { analyzeText, buildAnalysisPrompt } = await import("./analysis");
    const contract = "Contract clause. ".repeat(2000);
    const { coverageNotices } = buildAnalysisPrompt(contract);
    const fetchMock = vi.fn().mockResolvedValue(
      providerResponse(
        "completed",
        JSON.stringify({
          ...JSON.parse(payload),
          coverage_notices: ["No region was provided.", ...coverageNotices],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const answer = await analyzeText(contract);
    expect(answer.result.coverage_notices).toEqual([
      ...coverageNotices,
      "No region was provided.",
    ]);
    expect(answer.result.key_points).toContain(coverageNotices[0]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerResponse("completed", "{"))
      .mockResolvedValueOnce(providerResponse("incomplete"));
    vi.stubGlobal("fetch", fetchMock);
    const { analyzeText } = await import("./analysis");

    await expect(analyzeText("Monthly payment agreement")).rejects.toThrow(
      /Analysis response did not complete.*max_output_tokens/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "accepts completed output (repair: %s)",
    async (repair) => {
      const fetchMock = vi.fn();
      if (repair)
        fetchMock.mockResolvedValueOnce(providerResponse("completed", "{"));
      fetchMock.mockResolvedValueOnce(providerResponse("completed"));
      vi.stubGlobal("fetch", fetchMock);
      const { analyzeText } = await import("./analysis");

      const answer = await analyzeText("Monthly payment agreement");
      expect(answer.result.key_points).toContain("Payment is monthly");
      expect(answer.provider).toBe("primary-openai-compatible");
      expect(answer.promptTokens).toBe(repair ? 24 : 12);
      expect(answer.completionTokens).toBe(repair ? 14 : 7);
      expect(fetchMock).toHaveBeenCalledTimes(repair ? 2 : 1);
    },
  );
});

describe("analysis JSON format compatibility", () => {
  it.each([
    { message: "Unsupported parameter: text.format", param: "text.format" },
    { message: "Unsupported parameter", param: "response_format" },
    { message: "Invalid value: json_object", param: null },
  ])("retries a rejected JSON-format option: $message", async (error) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error }, { status: 400 }))
      .mockResolvedValueOnce(providerResponse("completed"));
    vi.stubGlobal("fetch", fetchMock);
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText("Monthly payment agreement");
    expect(answer.provider).toBe("primary-openai-compatible");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(bodies[0].text).toEqual({ format: { type: "json_object" } });
    expect(bodies[1]).not.toHaveProperty("text");
  });

  it.each([
    { status: 400, message: "Unsupported model audit-model", param: "model" },
    { status: 429, message: "JSON mode requests are not supported during overload", param: null },
    { status: 503, message: "JSON mode service unavailable", param: null },
  ])("does not resend an unrelated $status error to the same model", async ({ status, ...error }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error }, { status }))
      .mockResolvedValueOnce(providerResponse("completed"));
    vi.stubGlobal("fetch", fetchMock);
    const { analyzeText } = await import("./analysis");

    const answer = await analyzeText("Monthly payment agreement");
    expect(answer.provider).toBe("openrouter");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("analysis.test");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("openrouter.ai");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)).text)
      .toEqual({ format: { type: "json_object" } });
  });
});
