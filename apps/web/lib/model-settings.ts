export const PRIMARY_MODEL_OPTIONS = [
  "claude-opus-4-6-thinking",
  "claude-sonnet-4-6",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-flash",
  "gemini-3.1-pro-high",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-oss-120b-medium",
] as const;

export type PrimaryModel = (typeof PRIMARY_MODEL_OPTIONS)[number];

const primaryModelSet = new Set<string>(PRIMARY_MODEL_OPTIONS);
const PRIMARY_LLM_BASE_URL =
  process.env.PRIMARY_LLM_BASE_URL || "https://efficient-sightlessly-ouida.ngrok-free.dev/v1";
const MODELS_ENDPOINT_TIMEOUT_MS = 5000;

export function isAllowedPrimaryModel(value: string): value is PrimaryModel {
  return primaryModelSet.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function listAvailablePrimaryModels(): Promise<PrimaryModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_ENDPOINT_TIMEOUT_MS);

  try {
    const response = await fetch(`${PRIMARY_LLM_BASE_URL}/models`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Model list request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { data?: unknown };
    const rawModels = Array.isArray(payload.data) ? payload.data : [];
    const availableModels = rawModels
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string") {
          return null;
        }

        const modelId = entry.id.trim();
        return isAllowedPrimaryModel(modelId) ? modelId : null;
      })
      .filter((model): model is PrimaryModel => model !== null);

    return Array.from(new Set(availableModels));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load available models from ngrok: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
