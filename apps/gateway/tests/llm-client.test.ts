import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenAiCompatibleClient,
  isEligibleOpenRouterFallback,
  safeProviderFailureMetadata,
  type FetchImplementation,
} from "../src/pipeline/llm-client";

afterEach(() => {
  vi.useRealTimers();
});

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

  it("does not read provider settings from process.env", () => {
    const prior = process.env.PRIMARY_LLM_BASE_URL;
    process.env.PRIMARY_LLM_BASE_URL = "file:///must-not-be-used";
    try {
      expect(() =>
        createOpenAiCompatibleClient("https://explicit.example/v1"),
      ).not.toThrow();
    } finally {
      if (prior === undefined) delete process.env.PRIMARY_LLM_BASE_URL;
      else process.env.PRIMARY_LLM_BASE_URL = prior;
    }
  });

  it("disables ambient SDK logging and unrelated OpenAI credentials", () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    vi.stubEnv("OPENAI_ORG_ID", "ambient-organization");
    vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");
    vi.stubEnv("OPENAI_ADMIN_KEY", "ambient-admin-key");
    vi.stubEnv("OPENAI_WEBHOOK_SECRET", "ambient-webhook-secret");
    try {
      const client = createOpenAiCompatibleClient(
        "https://explicit.example/v1",
        "explicit-key",
      );

      expect(client.logLevel).toBe("off");
      expect(client.organization).toBeNull();
      expect(client.project).toBeNull();
      expect(client.adminAPIKey).toBeNull();
      expect(client.webhookSecret).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("strips ambient custom headers before provider requests", async () => {
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      "Authorization: Bearer ambient-secret\nX-Ambient: private-value",
    );
    let outboundHeaders: Headers | undefined;
    const fetchImplementation: FetchImplementation = async (_input, init) => {
      outboundHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: "response-test",
          object: "response",
          status: "completed",
          output: [],
          output_text: "ok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const client = createOpenAiCompatibleClient(
        "https://explicit.example/v1",
        "explicit-key",
        {
          publicServiceUrl: "https://service.example",
          appName: "Configured App",
          fetch: fetchImplementation,
        },
      );
      await client.responses.create({
        model: "configured-model",
        input: "private request",
      });

      expect(outboundHeaders?.get("Authorization")).toBe(
        "Bearer explicit-key",
      );
      expect(outboundHeaders?.get("X-Ambient")).toBeNull();
      expect(outboundHeaders?.get("HTTP-Referer")).toBe(
        "https://service.example",
      );
      expect(outboundHeaders?.get("X-Title")).toBe("Configured App");
      expect(JSON.stringify([...((outboundHeaders ?? new Headers()).entries())])).not.toContain(
        "ambient-secret",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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

describe("safeProviderFailureMetadata", () => {
  it("keeps only allowlisted machine-readable fields", () => {
    const providerError = Object.assign(
      new Error(
        "private prompt primary-key https://primary.test/v1 upstream body",
      ),
      {
        name: "NotFoundError",
        status: 404,
        code: "model_not_found",
        requestID: "req_safe123",
        responseBody: "private provider body",
      },
    );

    const metadata = safeProviderFailureMetadata(
      "primary-openai-compatible",
      "primary/model",
      providerError,
    );

    expect(metadata).toEqual({
      provider: "primary-openai-compatible",
      model: "primary/model",
      errorClass: "NotFoundError",
      statusCode: 404,
      providerCode: "model_not_found",
      upstreamRequestId: "req_safe123",
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("primary-key");
    expect(serialized).not.toContain("https://primary.test/v1");
    expect(serialized).not.toContain("private provider body");
  });

  it("drops values that are not safe machine identifiers", () => {
    const metadata = safeProviderFailureMetadata(
      "openrouter",
      "fallback/model",
      Object.assign(new Error("failure"), {
        name: "Bad name with spaces",
        status: 999,
        code: "code with spaces",
        request_id: "id\nwith-newline",
      }),
    );

    expect(metadata).toEqual({
      provider: "openrouter",
      model: "fallback/model",
      errorClass: "Error",
    });
  });
});
