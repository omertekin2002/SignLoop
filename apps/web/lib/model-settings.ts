import { getErrorMessage, isRecord } from "@/lib/utils";

export type PrimaryModel = string;

export const PRIMARY_LLM_BASE_URL =
  process.env.PRIMARY_LLM_BASE_URL || "https://efficient-sightlessly-ouida.ngrok-free.dev/v1";
const MODELS_ENDPOINT_TIMEOUT_MS = 5000;
const MODELS_CACHE_TTL_MS = 60_000;
// Negative cache: when the ngrok /models lookup fails, remember that briefly so an outage doesn't
// make every settings request pay the full 5s timeout. Shorter than the success TTL so recovery is
// picked up quickly.
const MODELS_NEGATIVE_CACHE_TTL_MS = 10_000;

let modelsSnapshotCache: { value: PrimaryModel[]; error: boolean; expiresAt: number } | null = null;

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
    throw new Error(`Failed to load available models from ngrok: ${getErrorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function getModelAvailabilitySnapshot(): Promise<{
  availablePrimaryModels: PrimaryModel[];
  // True when the lookup failed (ngrok unreachable) — distinct from a genuinely empty model list.
  // Callers use it to trust the user's saved model instead of resetting/rejecting it on an outage.
  error: boolean;
}> {
  const now = Date.now();
  if (modelsSnapshotCache && modelsSnapshotCache.expiresAt > now) {
    return { availablePrimaryModels: modelsSnapshotCache.value, error: modelsSnapshotCache.error };
  }

  try {
    const availablePrimaryModels = await listRemoteModelIds();
    // The model list changes rarely, so a short TTL spares every settings load a full round-trip to
    // the (slow, no-store) ngrok /models endpoint.
    modelsSnapshotCache = { value: availablePrimaryModels, error: false, expiresAt: now + MODELS_CACHE_TTL_MS };
    return { availablePrimaryModels, error: false };
  } catch (error) {
    // ngrok /models is unreachable — briefly negative-cache the failure (so we don't re-pay the 5s
    // timeout on every request) and flag error:true so callers can keep the saved model.
    console.error("Failed to load available models from ngrok", getErrorMessage(error));
    modelsSnapshotCache = { value: [], error: true, expiresAt: now + MODELS_NEGATIVE_CACHE_TTL_MS };
    return { availablePrimaryModels: [], error: true };
  }
}
