import { describe, expect, it, vi } from "vitest";
import {
  resolvePrimaryModel,
  PRIMARY_LLM_MODEL,
  createOpenAiCompatibleClient,
  LlmResponseValidationError,
} from "./llm-client";

describe("createOpenAiCompatibleClient", () => {
  it("fails closed when the endpoint is absent", () => {
    expect(() => createOpenAiCompatibleClient("", "configured-key")).toThrow(
      /base URL is not configured/i,
    );
  });

  it("supports intentionally unauthenticated compatible endpoints", () => {
    expect(() =>
      createOpenAiCompatibleClient("https://provider.example/v1"),
    ).not.toThrow();
  });

  it("rejects non-HTTP provider URLs", () => {
    expect(() =>
      createOpenAiCompatibleClient("file:///tmp/provider", "configured-key"),
    ).toThrow(/must use HTTP or HTTPS/i);
  });
});

describe("LlmResponseValidationError", () => {
  it("can be distinguished from transport failures by fallback policy", () => {
    const error = new LlmResponseValidationError("invalid structured output");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LlmResponseValidationError");
  });
});


it("distinguishes unavailable primary from the configured default", () => {
  expect(resolvePrimaryModel(null)).toBeNull();
  expect(resolvePrimaryModel(undefined)).toBe(PRIMARY_LLM_MODEL);
});

describe("runWithPrimaryAndOpenRouterFallback", () => {
  it("runs a pinned OpenRouter model directly and never touches the primary endpoint", async () => {
    vi.resetModules();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://primary.test/v1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { runWithPrimaryAndOpenRouterFallback, OPENROUTER_BASE_URL } = await import("./llm-client");
      const calls: Array<{ base: string; model: string }> = [];
      const pinned = await runWithPrimaryAndOpenRouterFallback("openrouter/free", async (client, model) => {
        calls.push({ base: client.baseURL, model });
        return "ok";
      });
      expect(pinned).toEqual({ result: "ok", provider: "openrouter", model: "openrouter/free" });
      expect(calls).toEqual([{ base: OPENROUTER_BASE_URL, model: "openrouter/free" }]);

      const chained = await runWithPrimaryAndOpenRouterFallback("openrouter/free", async (_client, model) => {
        if (model === "openrouter/free") throw new Error("router busy");
        return model;
      });
      expect(chained).toMatchObject({ provider: "openrouter", model: "google/gemma-4-31b-it:free" });
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });
});
