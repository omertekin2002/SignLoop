import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import("./chat-engine-config");
}

describe("chat engine tool settings", () => {
  it("reads search, reader and fetch settings from the environment on every call", async () => {
    const config = await load({
      WEB_SEARCH_PROVIDER: "brave",
      BRAVE_SEARCH_API_KEY: "brave-key",
      FIRECRAWL_API_KEY: "fc-key",
      GEMINI_API_KEY: "gemini-key",
      GEMINI_SEARCH_MODEL: "gemini-2.5-pro",
      JINA_API_KEY: "jina-key",
      NEXT_PUBLIC_APP_URL: "https://signloop.test",
    });
    expect(config.webSearchConfig()).toEqual({
      provider: "brave",
      braveApiKey: "brave-key",
      firecrawlApiKey: "fc-key",
      geminiApiKey: "gemini-key",
      geminiModel: "gemini-2.5-pro",
    });
    expect(config.urlReaderConfig()).toEqual({
      firecrawlApiKey: "fc-key",
      jinaApiKey: "jina-key",
    });
    expect(config.httpFetchConfig()).toEqual({
      userAgent: "SignLoop/1.0 (+https://signloop.test)",
    });
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("JINA_API_KEY", "rotated");
    expect(config.httpFetchConfig().userAgent).toBe(
      "SignLoop/1.0 (+http://localhost:3000)",
    );
    expect(config.urlReaderConfig().jinaApiKey).toBe("rotated");
  });
});

describe("chatProviderCandidates", () => {
  const provider = {
    PRIMARY_LLM_BASE_URL: "https://primary.test/v1",
    PRIMARY_LLM_API_KEY: "primary-key",
    OPENROUTER_BASE_URL: "https://openrouter.test/v1",
    OPENROUTER_API_KEY: "or-key",
    NEXT_PUBLIC_APP_URL: "https://signloop.test",
  };
  const chain = (candidates: { provider: string; model: string }[]) =>
    candidates.map(({ provider, model }) => `${provider}:${model}`);

  it("tries the selected primary model, then the OpenRouter chain", async () => {
    const { chatProviderCandidates } = await load(provider);
    const candidates = chatProviderCandidates("my-model");
    expect(chain(candidates)).toEqual([
      "primary-openai-compatible:my-model",
      "openrouter:google/gemma-4-31b-it:free",
      "openrouter:openai/gpt-oss-120b:free",
      "openrouter:openrouter/free",
    ]);
    expect(candidates[0]).toEqual({
      kind: "openai-responses",
      provider: "primary-openai-compatible",
      model: "my-model",
      baseURL: "https://primary.test/v1",
      apiKey: "primary-key",
      headers: { "HTTP-Referer": "https://signloop.test", "X-Title": "SignLoop" },
    });
    expect(candidates[1]).toMatchObject({
      baseURL: "https://openrouter.test/v1",
      apiKey: "or-key",
    });
  });

  it("puts a pinned OpenRouter model first and skips the primary endpoint", async () => {
    const { chatProviderCandidates } = await load(provider);
    expect(chain(chatProviderCandidates("openrouter/free"))).toEqual([
      "openrouter:openrouter/free",
      "openrouter:google/gemma-4-31b-it:free",
      "openrouter:openai/gpt-oss-120b:free",
    ]);
    expect(chain(chatProviderCandidates(null))[0]).toBe(
      "openrouter:google/gemma-4-31b-it:free",
    );
  });

  it("leaves out providers that are not configured", async () => {
    const withoutFallback = await load({ ...provider, OPENROUTER_API_KEY: "" });
    expect(chain(withoutFallback.chatProviderCandidates("my-model"))).toEqual([
      "primary-openai-compatible:my-model",
    ]);
    const withoutPrimary = await load({ ...provider, PRIMARY_LLM_BASE_URL: "" });
    expect(chain(withoutPrimary.chatProviderCandidates("my-model"))[0]).toBe(
      "openrouter:google/gemma-4-31b-it:free",
    );
  });

  it("generates images on the primary endpoint", async () => {
    const { imageGenerationConfig } = await load(provider);
    expect(imageGenerationConfig()).toEqual({
      baseURL: "https://primary.test/v1",
      apiKey: "primary-key",
      model: "gpt-image-2.5-sunburst",
      referer: "https://signloop.test",
      appName: "SignLoop",
    });
  });
});
