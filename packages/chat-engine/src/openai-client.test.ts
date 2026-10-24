import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleClient } from "./openai-client";

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

  it("disables ambient SDK logging and unrelated OpenAI credentials", () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    vi.stubEnv("OPENAI_ORG_ID", "ambient-organization");
    vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");
    vi.stubEnv("OPENAI_ADMIN_KEY", "ambient-admin-key");
    vi.stubEnv("OPENAI_WEBHOOK_SECRET", "ambient-webhook-secret");
    try {
      const client = createOpenAiCompatibleClient("https://explicit.example/v1", "explicit-key");
      expect(client.logLevel).toBe("off");
      expect(client.organization).toBeNull();
      expect(client.project).toBeNull();
      expect(client.adminAPIKey).toBeNull();
      expect(client.webhookSecret).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sends only explicit headers, including the configured identity", async () => {
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", "Authorization: Bearer ambient-secret\nX-Ambient: private-value");
    const outbound: Headers[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify({ id: "response-test", object: "response", status: "completed", output: [], output_text: "ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      await createOpenAiCompatibleClient("https://explicit.example/v1", "explicit-key", {
        referer: "https://app.test",
        appName: "App",
      }).responses.create({ model: "configured-model", input: "private request" });
      await createOpenAiCompatibleClient("https://explicit.example/v1").responses.create({
        model: "configured-model",
        input: "private request",
      });
      expect(outbound.map((headers) => Object.fromEntries(headers.entries()))).toEqual([
        {
          accept: "application/json",
          authorization: "Bearer explicit-key",
          "content-type": "application/json",
          "http-referer": "https://app.test",
          "x-title": "App",
        },
        {
          accept: "application/json",
          authorization: "Bearer not-required",
          "content-type": "application/json",
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
