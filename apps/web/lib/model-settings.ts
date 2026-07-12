import { getErrorMessage, isRecord } from "@/lib/utils";

export type PrimaryModel = string;

export const PRIMARY_LLM_BASE_URL =
  process.env.PRIMARY_LLM_BASE_URL?.trim() ?? "";
const PRIMARY_LLM_API_KEY = process.env.PRIMARY_LLM_API_KEY?.trim() ?? "";
const MODELS_ENDPOINT_TIMEOUT_MS = 5000;
const MODELS_CACHE_TTL_MS = 60_000;
// Negative cache: when the primary /models lookup fails, remember that briefly so an outage doesn't
// make every settings request pay the full 5s timeout. Shorter than the success TTL so recovery is
// picked up quickly.
const MODELS_NEGATIVE_CACHE_TTL_MS = 10_000;

let modelsSnapshotCache: { value: PrimaryModel[]; expiresAt: number } | null =
  null;
let modelsSnapshotPromise: Promise<PrimaryModel[]> | null = null;

async function listRemoteModelIds(): Promise<string[]> {
  if (!PRIMARY_LLM_BASE_URL || !PRIMARY_LLM_API_KEY) {
    throw new Error("Primary LLM endpoint and API key must both be configured");
  }

  const baseUrl = new URL(PRIMARY_LLM_BASE_URL);
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new Error("Primary LLM endpoint must use HTTP or HTTPS");
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    MODELS_ENDPOINT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${PRIMARY_LLM_BASE_URL.replace(/\/+$/, "")}/models`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${PRIMARY_LLM_API_KEY}` },
        signal: controller.signal,
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new Error(
        `Model list request failed with status ${response.status}`,
      );
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
    throw new Error(
      `Failed to load available primary models: ${getErrorMessage(error)}`,
    );
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

  // An absent or half-configured primary provider is intentionally unavailable. In particular,
  // never fall back to a hard-coded development tunnel or invent an authentication token.
  if (!PRIMARY_LLM_BASE_URL || !PRIMARY_LLM_API_KEY) {
    return { availablePrimaryModels: [] };
  }

  try {
    modelsSnapshotPromise ??= listRemoteModelIds().finally(() => {
      modelsSnapshotPromise = null;
    });
    const availablePrimaryModels = await modelsSnapshotPromise;
    // The model list changes rarely, so a short TTL spares every settings load a full round-trip to
    // the remote, no-store /models endpoint. The shared promise also coalesces concurrent loads.
    modelsSnapshotCache = {
      value: availablePrimaryModels,
      expiresAt: now + MODELS_CACHE_TTL_MS,
    };
    return { availablePrimaryModels };
  } catch (error) {
    // The primary /models endpoint is unreachable — treat it as unavailable so the UI honestly
    // shows the OpenRouter fallback rather than advertising an unreachable model. Negative-cache the
    // empty result briefly so an outage doesn't make every settings load pay the full 5s timeout.
    console.error(
      "Failed to load available primary models",
      getErrorMessage(error),
    );
    modelsSnapshotCache = {
      value: [],
      expiresAt: now + MODELS_NEGATIVE_CACHE_TTL_MS,
    };
    return { availablePrimaryModels: [] };
  }
}
