import { isRecord } from "@/lib/utils";

export type PrimaryModel = string;

export const PRIMARY_LLM_BASE_URL =
  process.env.PRIMARY_LLM_BASE_URL || "https://efficient-sightlessly-ouida.ngrok-free.dev/v1";
const MODELS_ENDPOINT_TIMEOUT_MS = 5000;
const MODELS_CACHE_TTL_MS = 60_000;

let modelsSnapshotCache: { value: PrimaryModel[]; expiresAt: number } | null = null;

async function listRemoteModelIds(): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_ENDPOINT_TIMEOUT_MS);

  try {
    const response = await fetch(`${PRIMARY_LLM_BASE_URL.replace(/\/+$/, "")}/models`, {
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
  const now = Date.now();
  if (modelsSnapshotCache && modelsSnapshotCache.expiresAt > now) {
    return { availablePrimaryModels: modelsSnapshotCache.value };
  }

  try {
    const availablePrimaryModels = await listRemoteModelIds();
    // Cache only successful lookups; the model list changes rarely, so a short TTL spares every
    // settings load a full round-trip to the (slow, no-store) ngrok /models endpoint.
    modelsSnapshotCache = { value: availablePrimaryModels, expiresAt: now + MODELS_CACHE_TTL_MS };
    return { availablePrimaryModels };
  } catch (error) {
    // ngrok /models is unreachable — return no models so the selector falls back to "OpenRouter"
    // (same as a genuinely empty list) instead of failing the settings request.
    console.error("Failed to load available models from ngrok", error);
    return { availablePrimaryModels: [] };
  }
}
