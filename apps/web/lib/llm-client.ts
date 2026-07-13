import OpenAI from "openai";
import { PRIMARY_LLM_BASE_URL } from "@/lib/model-settings";
import { getErrorMessage } from "@/lib/utils";

// Shared LLM provider configuration and the primary -> OpenRouter fallback used by
// both the contract-analysis pipeline (lib/analysis.ts) and the chat pipeline (lib/chat.ts).
// Keeping it here prevents the provider config, client factory, and fallback loop from
// drifting between the two callers.

export { PRIMARY_LLM_BASE_URL };

export const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY?.trim() || undefined;
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-120b:free",
  "openrouter/free",
];
export const PRIMARY_LLM_MODEL =
  process.env.PRIMARY_LLM_MODEL?.trim() || "gemini-3-flash";
export const PRIMARY_LLM_API_KEY =
  process.env.PRIMARY_LLM_API_KEY?.trim() || undefined;
export const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
export const APP_NAME = "SignLoop";

export type LlmProvider = "primary-openai-compatible" | "openrouter";

/** A provider returned content, but that content cannot safely be treated as an analysis. */
export class LlmResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResponseValidationError";
  }
}

export function createOpenAiCompatibleClient(
  baseURL: string,
  apiKey?: string,
  options?: { timeoutMs?: number },
): OpenAI {
  const resolvedBaseUrl = baseURL.trim();
  // The OpenAI client requires a non-empty value even when the compatible endpoint does not use
  // authentication. Real configured credentials still pass through unchanged.
  const resolvedApiKey = apiKey?.trim() || "not-required";

  if (!resolvedBaseUrl) {
    throw new Error("LLM base URL is not configured");
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(resolvedBaseUrl);
  } catch {
    throw new Error("LLM base URL is invalid");
  }
  if (
    parsedBaseUrl.protocol !== "https:" &&
    parsedBaseUrl.protocol !== "http:"
  ) {
    throw new Error("LLM base URL must use HTTP or HTTPS");
  }

  return new OpenAI({
    apiKey: resolvedApiKey,
    baseURL: resolvedBaseUrl,
    timeout: options?.timeoutMs ?? 60_000,
    maxRetries: 1,
    defaultHeaders: {
      "HTTP-Referer": SITE_URL,
      "X-Title": APP_NAME,
    },
  });
}

export function extractResponseOutputText(
  response: OpenAI.Responses.Response,
): string | null {
  const directOutputText =
    typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (directOutputText) {
    return directOutputText;
  }

  const chunks: string[] = [];
  const outputItems = Array.isArray(response.output) ? response.output : [];

  for (const outputItem of outputItems) {
    if (typeof outputItem !== "object" || outputItem === null) continue;

    const content = Array.isArray((outputItem as { content?: unknown }).content)
      ? ((outputItem as { content?: unknown[] }).content ?? [])
      : [];

    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const candidate = part as { type?: unknown; text?: unknown };
      if (
        candidate.type === "output_text" &&
        typeof candidate.text === "string"
      ) {
        chunks.push(candidate.text);
      }
    }
  }

  const joined = chunks.join("").trim();
  return joined.length > 0 ? joined : null;
}

// Resolve the model to call: honor a caller-requested non-empty model, otherwise fall back to
// the configured default.
export function resolvePrimaryModel(requested?: string | null): string {
  return typeof requested === "string" && requested.trim()
    ? requested.trim()
    : PRIMARY_LLM_MODEL;
}

// Run `run` against the primary endpoint, and on failure iterate the ordered OpenRouter
// fallback models. Aborts (via options.signal) are re-thrown without triggering fallback.
export async function runWithPrimaryAndOpenRouterFallback<T>(
  selectedPrimaryModel: string,
  run: (client: OpenAI, model: string) => Promise<T>,
  options?: {
    signal?: AbortSignal;
    shouldFallback?: (error: unknown) => boolean;
  },
): Promise<{ result: T; provider: LlmProvider; model: string }> {
  let primaryError: unknown;

  try {
    const primaryClient = createOpenAiCompatibleClient(
      PRIMARY_LLM_BASE_URL,
      PRIMARY_LLM_API_KEY,
    );
    const result = await run(primaryClient, selectedPrimaryModel);
    return {
      result,
      provider: "primary-openai-compatible",
      model: selectedPrimaryModel,
    };
  } catch (error) {
    primaryError = error;
    if (options?.signal?.aborted) {
      throw error;
    }
    if (options?.shouldFallback && !options.shouldFallback(error)) {
      throw error;
    }

    const primaryErrorMessage = getErrorMessage(error);
    console.warn("Primary LLM call failed, falling back to OpenRouter", {
      model: selectedPrimaryModel,
      error: primaryErrorMessage,
    });

    if (!OPENROUTER_API_KEY) {
      throw new Error(
        `Primary endpoint failed and OpenRouter fallback is not configured. Primary error: ${primaryErrorMessage}`,
      );
    }

    const fallbackClient = createOpenAiCompatibleClient(
      OPENROUTER_BASE_URL,
      OPENROUTER_API_KEY,
    );
    const fallbackFailures: string[] = [];

    for (const fallbackModel of OPENROUTER_MODELS) {
      try {
        const result = await run(fallbackClient, fallbackModel);
        if (fallbackModel !== OPENROUTER_MODELS[0]) {
          console.warn(
            "OpenRouter fallback model succeeded after earlier model failed",
            {
              firstFallbackModel: OPENROUTER_MODELS[0],
              successfulFallbackModel: fallbackModel,
            },
          );
        }
        return { result, provider: "openrouter", model: fallbackModel };
      } catch (fallbackError) {
        if (options?.signal?.aborted) {
          throw fallbackError;
        }
        if (options?.shouldFallback && !options.shouldFallback(fallbackError)) {
          throw fallbackError;
        }

        const fallbackErrorMessage = getErrorMessage(fallbackError);
        fallbackFailures.push(`${fallbackModel}: ${fallbackErrorMessage}`);
        console.warn("OpenRouter fallback model failed", {
          model: fallbackModel,
          error: fallbackErrorMessage,
        });
      }
    }

    throw new Error(
      `Primary endpoint failed (${getErrorMessage(primaryError)}) and OpenRouter fallback failed (${fallbackFailures.join(
        " | ",
      )})`,
    );
  }
}
