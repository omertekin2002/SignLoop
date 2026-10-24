export const OPENROUTER_FALLBACK_MODELS = Object.freeze([
  "openrouter/free",
] as const);

export const MAX_OPENROUTER_FALLBACK_MODELS = 5;

export type WebToolsConfig = Readonly<{
  provider?: "brave" | "firecrawl" | "gemini";
  braveApiKey?: string | null;
  firecrawlApiKey?: string | null;
  jinaApiKey?: string | null;
  geminiApiKey?: string | null;
  geminiModel?: string;
}>;

export type GeminiChatConfig = Readonly<{
  apiKey: string;
  model: string;
}>;

export type PrimaryLlmConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
  modelWasDefaulted: boolean;
}>;

export type OpenRouterConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  models: readonly string[];
}>;

export type ServiceConfig = Readonly<{
  webTools: WebToolsConfig;
  geminiChat: GeminiChatConfig | null;
  imageGenerationEnabled: boolean;
  imageGenerationModel: string;
  primaryLlm: PrimaryLlmConfig | null;
  openRouter: OpenRouterConfig | null;
  publicServiceUrl: string;
  appName: string;
  port: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  corsAllowedOrigins: ReadonlySet<string>;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function optionalValue(environment: Environment, name: string): string | null {
  const value = environment[name]?.trim();
  return value ? value : null;
}

function credentialValue(name: string, value: string): string {
  if (/\s/u.test(value)) {
    throw new Error(`${name} must not contain whitespace`);
  }
  return value;
}

function headerValue(name: string, value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return value;
}

function parsePositiveInteger(
  environment: Environment,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = optionalValue(environment, name);
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return parsed;
}

function parseHttpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }

  return value.replace(/\/+$/, "");
}

function parseGeminiModel(name: string, value: string): string {
  const normalized = value.replace(/^models\//, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function parseProviderModel(name: string, value: string): string {
  const model = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model)) {
    throw new Error(`${name} contains an invalid model ID`);
  }
  return model;
}

function parseOpenRouterModels(environment: Environment): readonly string[] {
  const configured = environment.OPENROUTER_FALLBACK_MODELS;
  if (configured === undefined) return OPENROUTER_FALLBACK_MODELS;

  const entries = configured.split(",").map((model) => model.trim());
  if (!entries.length || entries.some((model) => !model)) {
    throw new Error(
      "OPENROUTER_FALLBACK_MODELS must not contain empty model IDs",
    );
  }

  const models = [...new Set(entries)].map((model) =>
    parseProviderModel("OPENROUTER_FALLBACK_MODELS", model),
  );
  if (models.length > MAX_OPENROUTER_FALLBACK_MODELS) {
    throw new Error(
      `OPENROUTER_FALLBACK_MODELS supports at most ${MAX_OPENROUTER_FALLBACK_MODELS} models`,
    );
  }
  return Object.freeze(models);
}

function parseCorsOrigins(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set<string>();

  const origins = new Set<string>();
  for (const configuredOrigin of raw.split(",")) {
    const candidate = configuredOrigin.trim();
    if (!candidate) continue;
    if (candidate === "*") {
      throw new Error(
        "CORS_ALLOWED_ORIGINS must contain explicit origins, not a wildcard",
      );
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("CORS_ALLOWED_ORIGINS contains an invalid origin");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("CORS_ALLOWED_ORIGINS must contain only HTTP(S) origins");
    }
    origins.add(url.origin);
  }

  return origins;
}

/** Parse and validate all process configuration without exposing secret values. */
export function loadServiceConfig(
  environment: Environment = process.env,
): ServiceConfig {
  const rawGeminiApiKey = optionalValue(environment, "GEMINI_API_KEY");
  const geminiApiKey = rawGeminiApiKey
    ? credentialValue("GEMINI_API_KEY", rawGeminiApiKey)
    : null;
  const primaryBaseUrl = optionalValue(environment, "PRIMARY_LLM_BASE_URL");
  const rawPrimaryApiKey = optionalValue(environment, "PRIMARY_LLM_API_KEY");
  const primaryApiKey = rawPrimaryApiKey
    ? credentialValue("PRIMARY_LLM_API_KEY", rawPrimaryApiKey)
    : null;
  const configuredPrimaryModel = optionalValue(
    environment,
    "PRIMARY_LLM_MODEL",
  );
  const primaryModel = parseProviderModel(
    "PRIMARY_LLM_MODEL",
    configuredPrimaryModel ?? "gpt-6.1-sol",
  );

  if (
    (primaryBaseUrl && !primaryApiKey) ||
    (!primaryBaseUrl && primaryApiKey)
  ) {
    throw new Error(
      "PRIMARY_LLM_BASE_URL and PRIMARY_LLM_API_KEY must be configured together",
    );
  }

  const primaryLlm =
    primaryBaseUrl && primaryApiKey
      ? Object.freeze({
          baseUrl: parseHttpUrl("PRIMARY_LLM_BASE_URL", primaryBaseUrl),
          apiKey: primaryApiKey,
          model: primaryModel,
          modelWasDefaulted: configuredPrimaryModel === null,
        })
      : null;

  const rawOpenRouterApiKey = optionalValue(environment, "OPENROUTER_API_KEY");
  const openRouterApiKey = rawOpenRouterApiKey
    ? credentialValue("OPENROUTER_API_KEY", rawOpenRouterApiKey)
    : null;
  const openRouterBaseUrl =
    optionalValue(environment, "OPENROUTER_BASE_URL") ??
    "https://openrouter.ai/api/v1";
  const openRouter = openRouterApiKey
    ? Object.freeze({
        baseUrl: parseHttpUrl("OPENROUTER_BASE_URL", openRouterBaseUrl),
        apiKey: openRouterApiKey,
        models: parseOpenRouterModels(environment),
      })
    : null;

  // The Gemini key serves both grounded search and generation after the configured primary.
  const geminiChat = geminiApiKey
    ? Object.freeze({
        apiKey: geminiApiKey,
        model: parseGeminiModel(
          "GEMINI_CHAT_MODEL",
          optionalValue(environment, "GEMINI_CHAT_MODEL") ?? "gemini-3.8-flash",
        ),
      })
    : null;

  if (!geminiChat && !primaryLlm && !openRouter) {
    throw new Error(
      "Configure GEMINI_API_KEY, a primary LLM provider, or OPENROUTER_API_KEY",
    );
  }

  const port = parsePositiveInteger(environment, "PORT", 10_000, 65_535);
  const searchProvider = optionalValue(
    environment,
    "WEB_SEARCH_PROVIDER",
  )?.toLowerCase();
  if (
    searchProvider &&
    !["brave", "firecrawl", "gemini"].includes(searchProvider)
  ) {
    throw new Error("WEB_SEARCH_PROVIDER must be brave, firecrawl, or gemini");
  }
  const imageEnabled =
    optionalValue(environment, "ENABLE_IMAGE_GENERATION") ?? "false";
  if (imageEnabled !== "true" && imageEnabled !== "false") {
    throw new Error("ENABLE_IMAGE_GENERATION must be true or false");
  }
  if (imageEnabled === "true" && !primaryLlm) {
    throw new Error("ENABLE_IMAGE_GENERATION requires a primary LLM provider");
  }
  const integrationKey = (name: string) => {
    const value = optionalValue(environment, name);
    return value ? credentialValue(name, value) : null;
  };
  const geminiSearchModel = parseGeminiModel(
    "GEMINI_SEARCH_MODEL",
    optionalValue(environment, "GEMINI_SEARCH_MODEL") ?? "gemini-2.5-flash",
  );
  const publicServiceUrl = parseHttpUrl(
    "PUBLIC_SERVICE_URL",
    optionalValue(environment, "PUBLIC_SERVICE_URL") ??
      optionalValue(environment, "RENDER_EXTERNAL_URL") ??
      `http://localhost:${port}`,
  );

  return Object.freeze({
    webTools: Object.freeze({
      provider: searchProvider as WebToolsConfig["provider"],
      braveApiKey: integrationKey("BRAVE_SEARCH_API_KEY"),
      firecrawlApiKey: integrationKey("FIRECRAWL_API_KEY"),
      jinaApiKey: integrationKey("JINA_API_KEY"),
      geminiApiKey,
      geminiModel: geminiSearchModel,
    }),
    geminiChat,
    imageGenerationEnabled: imageEnabled === "true",
    imageGenerationModel: parseProviderModel(
      "IMAGE_GENERATION_MODEL",
      optionalValue(environment, "IMAGE_GENERATION_MODEL") ??
        "gpt-image-2.5-sunburst",
    ),
    primaryLlm,
    openRouter,
    publicServiceUrl,
    appName: headerValue(
      "APP_NAME",
      optionalValue(environment, "APP_NAME") ?? "SignLoop Chat Service",
    ),
    port,
    maxConcurrentRequests: parsePositiveInteger(
      environment,
      "MAX_CONCURRENT_REQUESTS",
      4,
      10_000,
    ),
    requestTimeoutMs: parsePositiveInteger(
      environment,
      "REQUEST_TIMEOUT_MS",
      275_000,
      3_600_000,
    ),
    corsAllowedOrigins: parseCorsOrigins(
      optionalValue(environment, "CORS_ALLOWED_ORIGINS"),
    ),
  });
}

let cachedConfig: ServiceConfig | undefined;

/** Read the environment at most once in the production process. */
export function getServiceConfig(): ServiceConfig {
  cachedConfig ??= loadServiceConfig();
  return cachedConfig;
}
