import { getErrorMessage, isRecord } from "@/lib/utils";

export type PrimaryModel = string;

export const IMAGE_GENERATION_MODEL = "gpt-image-2";

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

export type ModelAvailabilitySnapshot = {
  availablePrimaryModels: PrimaryModel[];
  imageGenerationAvailable: boolean;
};

function toModelAvailabilitySnapshot(
  remoteModelIds: readonly string[],
): ModelAvailabilitySnapshot {
  return {
    // Image-only models cannot satisfy the Responses API calls used by chat and analysis.
    availablePrimaryModels: remoteModelIds.filter(
      (model) =>
        !/^gpt-image-/i.test(model) && model !== "chatgpt-image-latest",
    ),
    imageGenerationAvailable: remoteModelIds.includes(IMAGE_GENERATION_MODEL),
  };
}

async function listRemoteModelIds(): Promise<string[]> {
  if (!PRIMARY_LLM_BASE_URL) {
    throw new Error("Primary LLM endpoint must be configured");
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
        headers: PRIMARY_LLM_API_KEY
          ? { Authorization: `Bearer ${PRIMARY_LLM_API_KEY}` }
          : undefined,
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

export async function getModelAvailabilitySnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<ModelAvailabilitySnapshot> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    modelsSnapshotCache &&
    modelsSnapshotCache.expiresAt > now
  ) {
    return toModelAvailabilitySnapshot(modelsSnapshotCache.value);
  }

  // There is intentionally no hard-coded provider URL. API keys remain optional because some
  // OpenAI-compatible endpoints are private-network or otherwise intentionally unauthenticated.
  if (!PRIMARY_LLM_BASE_URL) {
    return toModelAvailabilitySnapshot([]);
  }

  try {
    modelsSnapshotPromise ??= listRemoteModelIds().finally(() => {
      modelsSnapshotPromise = null;
    });
    const remoteModelIds = await modelsSnapshotPromise;
    // The model list changes rarely, so a short TTL spares every settings load a full round-trip to
    // the remote, no-store /models endpoint. The shared promise also coalesces concurrent loads.
    modelsSnapshotCache = {
      value: remoteModelIds,
      expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
    };
    return toModelAvailabilitySnapshot(remoteModelIds);
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
      expiresAt: Date.now() + MODELS_NEGATIVE_CACHE_TTL_MS,
    };
    return toModelAvailabilitySnapshot([]);
  }
}

export function resolveAvailablePrimaryModel(
  requested: string | null | undefined,
  availablePrimaryModels: readonly PrimaryModel[],
): PrimaryModel | null {
  const normalized = typeof requested === "string" ? requested.trim() : "";
  if (normalized && availablePrimaryModels.includes(normalized)) {
    return normalized;
  }

  return availablePrimaryModels[0] ?? null;
}
