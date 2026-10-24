import { describe, expect, it, vi } from "vitest";
import {
  APP_NAME,
  resolvePrimaryModel,
  PRIMARY_LLM_MODEL,
  createOpenAiCompatibleClient,
  LlmResponseValidationError,
  SITE_URL,
} from "./llm-client";

// The hardened client itself is tested in packages/chat-engine; this checks SignLoop's identity.
describe("createOpenAiCompatibleClient", () => {
  it("strips ambient custom headers before provider requests", async () => {
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", "Authorization: Bearer ambient-secret\nX-Ambient: private-value");
    let outbound: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ id: "response-test", object: "response", status: "completed", output: [], output_text: "ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      const client = createOpenAiCompatibleClient("https://explicit.example/v1", "explicit-key");
      await client.responses.create({ model: "configured-model", input: "private request" });
      expect(outbound?.get("Authorization")).toBe("Bearer explicit-key");
      expect(outbound?.get("X-Ambient")).toBeNull();
      expect(outbound?.get("Content-Type")).toBe("application/json");
      expect(outbound?.get("HTTP-Referer")).toBe(SITE_URL);
      expect(outbound?.get("X-Title")).toBe(APP_NAME);
      expect(JSON.stringify([...(outbound ?? new Headers()).entries()])).not.toContain("ambient-secret");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
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
