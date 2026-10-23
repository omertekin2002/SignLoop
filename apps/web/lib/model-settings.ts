import { readBoundedJson } from "@/lib/bounded-response";
import { getErrorMessage, isRecord } from "@/lib/utils";

export type PrimaryModel = string;

export const IMAGE_GENERATION_MODEL = "gpt-image-2";

// OpenRouter chain, tried in order when the primary endpoint fails or when the user pins one.
export const OPENROUTER_FREE_MODEL = "openrouter/free";
export const OPENROUTER_MODELS = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-120b:free",
  OPENROUTER_FREE_MODEL,
];
const OPENROUTER_CONFIGURED = Boolean(process.env.OPENROUTER_API_KEY?.trim());
/** Models a user may pin explicitly even while primary models are available. */
export const SELECTABLE_FALLBACK_MODELS: readonly string[] =
  OPENROUTER_CONFIGURED ? [OPENROUTER_FREE_MODEL] : [];

export function isOpenRouterModel(
  model: string | null | undefined,
): model is string {
  return typeof model === "string" && OPENROUTER_MODELS.includes(model);
}

/** The OpenRouter chain with a pinned model moved to the front. */
export function orderOpenRouterModels(
  pinned: string | null | undefined,
): string[] {
  return isOpenRouterModel(pinned)
    ? [pinned, ...OPENROUTER_MODELS.filter((model) => model !== pinned)]
    : [...OPENROUTER_MODELS];
}

export const PRIMARY_LLM_BASE_URL =
  process.env.PRIMARY_LLM_BASE_URL?.trim() ?? "";
const PRIMARY_LLM_API_KEY = process.env.PRIMARY_LLM_API_KEY?.trim() ?? "";
const MODELS_ENDPOINT_TIMEOUT_MS = 5000;
const MODELS_CACHE_TTL_MS = 60_000;
// Generation alone may use the last successful list for one extra minute while refreshing.
// Failures never move this hard limit; settings and selection validation never use this grace.
const MODELS_GENERATION_GRACE_MS = 60_000;
// Negative cache: when the primary /models lookup fails, remember that briefly so an outage doesn't
// make every settings request pay the full 5s timeout. Shorter than the success TTL so recovery is
// picked up quickly.
const MODELS_NEGATIVE_CACHE_TTL_MS = 10_000;

let modelsSnapshotCache: { value: PrimaryModel[]; expiresAt: number } | null =
  null;
let lastSuccessfulSnapshot: {
  value: PrimaryModel[];
  staleUntil: number;
} | null = null;
let modelsSnapshotPromise: Promise<PrimaryModel[]> | null = null;

export type ModelDiscoverySource =
  | "cache"
  | "negative-cache"
  | "stale-cache"
  | "refresh"
  | "in-flight"
  | "unconfigured";

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

    const payload = (await readBoundedJson(response, controller.signal)) as {
      data?: unknown;
    };
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

async function refreshModelIds(): Promise<PrimaryModel[]> {
  try {
    const remoteModelIds = await listRemoteModelIds();
    const expiresAt = Date.now() + MODELS_CACHE_TTL_MS;
    modelsSnapshotCache = {
      value: remoteModelIds,
      expiresAt,
    };
    lastSuccessfulSnapshot = {
      value: remoteModelIds,
      staleUntil: expiresAt + MODELS_GENERATION_GRACE_MS,
    };
    return remoteModelIds;
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
    return [];
  }
}

function refreshModels(): Promise<PrimaryModel[]> {
  return (modelsSnapshotPromise ??= refreshModelIds().finally(() => {
    modelsSnapshotPromise = null;
  }));
}

export async function getModelAvailabilitySnapshot(options?: {
  forceRefresh?: boolean;
  /** Opt generation into bounded stale reuse. Must retain the promise in the request lifecycle
   * (Next after/waitUntil), including when joining another request's in-flight refresh. */
  deferRefresh?: (refresh: Promise<void>) => void;
  onSource?: (source: ModelDiscoverySource) => void;
}): Promise<ModelAvailabilitySnapshot> {
  const now = Date.now();
  const cacheFresh = modelsSnapshotCache && modelsSnapshotCache.expiresAt > now;
  const successfulCache =
    modelsSnapshotCache?.value === lastSuccessfulSnapshot?.value;
  if (!options?.forceRefresh) {
    if (cacheFresh && (!options?.deferRefresh || successfulCache)) {
      options?.onSource?.(successfulCache ? "cache" : "negative-cache");
      return toModelAvailabilitySnapshot(modelsSnapshotCache!.value);
    }
    if (
      options?.deferRefresh &&
      lastSuccessfulSnapshot &&
      lastSuccessfulSnapshot.staleUntil > now
    ) {
      // Capture before starting refresh: a successful empty list is also authoritative.
      const value = lastSuccessfulSnapshot.value;
      // Respect the negative-cache retry delay, but retain any refresh already in progress.
      if (modelsSnapshotPromise || !cacheFresh) {
        options.deferRefresh(refreshModels().then(() => {}));
      }
      options.onSource?.("stale-cache");
      return toModelAvailabilitySnapshot(value);
    }
    if (cacheFresh) {
      options?.onSource?.("negative-cache");
      return toModelAvailabilitySnapshot(modelsSnapshotCache!.value);
    }
  }

  // No hard-coded provider URL; private endpoints may intentionally omit API credentials.
  if (!PRIMARY_LLM_BASE_URL) {
    options?.onSource?.("unconfigured");
    return toModelAvailabilitySnapshot([]);
  }
  options?.onSource?.(modelsSnapshotPromise ? "in-flight" : "refresh");
  return toModelAvailabilitySnapshot(await refreshModels());
}

export function resolveAvailablePrimaryModel(
  requested: string | null | undefined,
  availablePrimaryModels: readonly PrimaryModel[],
): PrimaryModel | null {
  const normalized = typeof requested === "string" ? requested.trim() : "";
  // An explicitly pinned OpenRouter model stays selected regardless of what the primary offers.
  if (normalized && SELECTABLE_FALLBACK_MODELS.includes(normalized)) {
    return normalized;
  }
  if (normalized && availablePrimaryModels.includes(normalized)) {
    return normalized;
  }

  return availablePrimaryModels[0] ?? null;
}
