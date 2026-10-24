import { describe, expect, it } from "vitest";
import { OPENROUTER_FALLBACK_MODELS, loadServiceConfig } from "../src/config";

const minimumEnvironment = {
  GEMINI_API_KEY: "gemini-secret",
  OPENROUTER_API_KEY: "openrouter-secret",
};

describe("loadServiceConfig", () => {
  it("applies standalone service defaults", () => {
    const config = loadServiceConfig(minimumEnvironment);

    expect(config.port).toBe(10_000);
    expect(config.maxConcurrentRequests).toBe(4);
    expect(config.requestTimeoutMs).toBe(275_000);
    expect(config.webTools.geminiModel).toBe("gemini-2.5-flash");
    expect(config.openRouter?.models).toEqual(OPENROUTER_FALLBACK_MODELS);
    expect(config.publicServiceUrl).toBe("http://localhost:10000");
  });

  it("uses PUBLIC_SERVICE_URL before the Render fallback", () => {
    const config = loadServiceConfig({
      ...minimumEnvironment,
      PUBLIC_SERVICE_URL: "https://public.example.test/",
      RENDER_EXTERNAL_URL: "https://render.example.test",
    });

    expect(config.publicServiceUrl).toBe("https://public.example.test");
  });

  it("supports a primary-only generation path", () => {
    const config = loadServiceConfig({
      GEMINI_API_KEY: "gemini-secret",
      PRIMARY_LLM_BASE_URL: "https://primary.example.test/v1",
      PRIMARY_LLM_API_KEY: "primary-secret",
    });

    expect(config.primaryLlm).toEqual({
      baseUrl: "https://primary.example.test/v1",
      apiKey: "primary-secret",
      model: "gpt-6.1-sol",
      modelWasDefaulted: true,
    });
    expect(config.openRouter).toBeNull();
  });

  it("marks explicit primary models and accepts deployments without Gemini", () => {
    const config = loadServiceConfig({
      PRIMARY_LLM_BASE_URL: "https://primary.example.test/v1",
      PRIMARY_LLM_API_KEY: "primary-secret",
      PRIMARY_LLM_MODEL: "provider/supported-model",
    });

    expect(config.webTools.geminiApiKey).toBeNull();
    expect(config.primaryLlm).toMatchObject({
      model: "provider/supported-model",
      modelWasDefaulted: false,
    });
  });

  it("parses ordered OpenRouter models, removes duplicates, and rejects empty IDs", () => {
    const config = loadServiceConfig({
      ...minimumEnvironment,
      OPENROUTER_FALLBACK_MODELS: "vendor/first, vendor/second, vendor/first",
    });

    expect(config.openRouter?.models).toEqual([
      "vendor/first",
      "vendor/second",
    ]);
    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        OPENROUTER_FALLBACK_MODELS: "vendor/first,,vendor/second",
      }),
    ).toThrow(/empty model IDs/i);
    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        OPENROUTER_FALLBACK_MODELS: "one,two,three,four,five,six",
      }),
    ).toThrow(/at most 5/i);
  });

  it("requires at least one complete generation path", () => {
    expect(() => loadServiceConfig({})).toThrow(
      /GEMINI_API_KEY.*OPENROUTER_API_KEY/i,
    );

    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        PRIMARY_LLM_BASE_URL: "https://primary.example.test/v1",
      }),
    ).toThrow(/configured together/i);
  });

  it("uses the Gemini key for chat generation on its own", () => {
    const config = loadServiceConfig({ GEMINI_API_KEY: "gemini-secret" });

    expect(config.geminiChat).toEqual({
      apiKey: "gemini-secret",
      model: "gemini-3.8-flash",
    });
    expect(config.primaryLlm).toBeNull();
    expect(config.openRouter).toBeNull();
    expect(
      loadServiceConfig({
        GEMINI_API_KEY: "gemini-secret",
        GEMINI_CHAT_MODEL: "models/gemini-3.7-flash",
      }).geminiChat?.model,
    ).toBe("gemini-3.7-flash");
    expect(() =>
      loadServiceConfig({
        GEMINI_API_KEY: "gemini-secret",
        GEMINI_CHAT_MODEL: "gemini flash",
      }),
    ).toThrow(/GEMINI_CHAT_MODEL is invalid/);
    expect(
      loadServiceConfig({ OPENROUTER_API_KEY: "openrouter-secret" }).geminiChat,
    ).toBeNull();
  });

  it("accepts only explicit HTTP CORS origins", () => {
    const config = loadServiceConfig({
      ...minimumEnvironment,
      CORS_ALLOWED_ORIGINS:
        "https://one.example.test, http://localhost:3000,https://one.example.test",
    });

    expect([...config.corsAllowedOrigins]).toEqual([
      "https://one.example.test",
      "http://localhost:3000",
    ]);
    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        CORS_ALLOWED_ORIGINS: "*",
      }),
    ).toThrow(/wildcard/i);
  });

  it("validates request-critical identifiers at startup", () => {
    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        GEMINI_SEARCH_MODEL: "models/gemini?key=bad",
      }),
    ).toThrow(/GEMINI_SEARCH_MODEL.*invalid/i);

    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        GEMINI_API_KEY: "invalid\nheader-value",
      }),
    ).toThrow(/GEMINI_API_KEY.*whitespace/i);

    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        APP_NAME: "unsafe\nheader",
      }),
    ).toThrow(/APP_NAME.*control/i);

    expect(
      loadServiceConfig({
        ...minimumEnvironment,
        GEMINI_SEARCH_MODEL: "models/gemini-2.5-flash",
      }).webTools.geminiModel,
    ).toBe("gemini-2.5-flash");
  });
});

it("validates explicit web integrations and opt-in images", () => {
  const config = loadServiceConfig({
    ...minimumEnvironment,
    PRIMARY_LLM_BASE_URL: "https://primary.test/v1",
    PRIMARY_LLM_API_KEY: "primary",
    WEB_SEARCH_PROVIDER: "brave",
    BRAVE_SEARCH_API_KEY: "brave",
    FIRECRAWL_API_KEY: "firecrawl",
    JINA_API_KEY: "jina",
    ENABLE_IMAGE_GENERATION: "true",
    IMAGE_GENERATION_MODEL: "gpt-image-2",
  });
  expect(config.webTools).toMatchObject({
    provider: "brave",
    braveApiKey: "brave",
    firecrawlApiKey: "firecrawl",
    jinaApiKey: "jina",
  });
  expect(config.imageGenerationEnabled).toBe(true);
  expect(loadServiceConfig(minimumEnvironment).imageGenerationEnabled).toBe(
    false,
  );
  expect(() =>
    loadServiceConfig({
      ...minimumEnvironment,
      ENABLE_IMAGE_GENERATION: "yes",
    }),
  ).toThrow(/true or false/);
  expect(() =>
    loadServiceConfig({
      ...minimumEnvironment,
      ENABLE_IMAGE_GENERATION: "true",
    }),
  ).toThrow(/primary/);
  expect(() =>
    loadServiceConfig({
      ...minimumEnvironment,
      WEB_SEARCH_PROVIDER: "unknown",
    }),
  ).toThrow(/WEB_SEARCH_PROVIDER/);
  expect(() =>
    loadServiceConfig({
      ...minimumEnvironment,
      BRAVE_SEARCH_API_KEY: "bad\nkey",
    }),
  ).toThrow(/whitespace/);
});
