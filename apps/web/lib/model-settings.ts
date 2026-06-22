export type PrimaryModel = string;

const UNSUPPORTED_PRIMARY_MODELS = new Set<string>(["gemini-3.1-flash-image"]);
export const PRIMARY_LLM_BASE_URL =
  process.env.PRIMARY_LLM_BASE_URL || "https://efficient-sightlessly-ouida.ngrok-free.dev/v1";
const MODELS_ENDPOINT_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isUsablePrimaryModel(value: string): value is PrimaryModel {
  const normalized = value.trim();
  return normalized.length > 0 && !UNSUPPORTED_PRIMARY_MODELS.has(normalized);
}

async function listRemoteModelIds(): Promise<string[]> {
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
    const modelIds = rawModels
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string") {
          return null;
        }

        return entry.id.trim() || null;
      })
      .filter((model): model is string => model !== null);

    return Array.from(new Set(modelIds));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load available models from ngrok: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function getModelAvailabilitySnapshot(): Promise<{
  availablePrimaryModels: PrimaryModel[];
}> {
  try {
    const remoteModelIds = await listRemoteModelIds();
    return {
      availablePrimaryModels: remoteModelIds.filter((model): model is PrimaryModel =>
        isUsablePrimaryModel(model),
      ),
    };
  } catch (error) {
    // ngrok /models is unreachable — return no models so the selector falls back to "OpenRouter"
    // (same as a genuinely empty list) instead of failing the settings request.
    console.error("Failed to load available models from ngrok", error);
    return { availablePrimaryModels: [] };
  }
}
