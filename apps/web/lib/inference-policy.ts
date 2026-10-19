import { createHash } from "node:crypto";

/**
 * Shared chat/analysis admission policy. claimChatAdmission enforces it and getInferenceQuota
 * reports it, so the published quota cannot drift from enforcement.
 *
 * Windows are fixed: a clock hour per principal and a UTC day service-wide (see the window SQL
 * in server-db.ts). Signed-in accounts are keyed by a SHA-256 of the stable application owner ID
 * resolved from WorkOS. Anonymous clients share one bucket; no spoofable IP header or resettable
 * cookie bypasses it, and its numbers are never reported to clients.
 */
export const INFERENCE_POLICY = {
  // windowSeconds describes the clock-hour SQL window to clients; it does not change it.
  account: { limit: 30, windowSeconds: 3600, concurrency: 2 },
  anonymous: { limit: 10, concurrency: 1 },
  // Defaults for the legacy CHAT_* variables, which govern both operations.
  global: { dailyLimit: 1_000, concurrency: 8 },
  shared: ["chat", "analysis"],
} as const;

export type AdmissionLimits = {
  principal: string;
  hourlyLimit: number;
  concurrency: number;
  globalDailyLimit: number;
  globalConcurrency: number;
};

/** A principal's hourly allowance. `resetAt` is the ISO instant the window ends. */
export type AccountQuota = {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
  concurrency: { limit: number; inUse: number };
};

/** Coarse service-wide state; global counts are never exposed. */
export type ServiceStatus = "ok" | "busy" | "exhausted";

export type InferenceQuota = { account: AccountQuota; service: ServiceStatus };

export type UsageResponse = InferenceQuota & {
  shared: readonly (typeof INFERENCE_POLICY.shared)[number][];
};

export type AdmissionReason = "busy" | "hourly" | "daily";

/** `quota` is the principal's state as admitted or rejected; it is omitted for anonymous callers. */
export type AdmissionGrant = {
  release: () => Promise<void>;
  quota?: AccountQuota;
};

/**
 * `retryAfter` is seconds until the limiting window resets, plus jitter so rejected clients do
 * not retry in lockstep. `resetAt` is that reset without jitter.
 */
export type AdmissionRejection = {
  retryAfter: number;
  reason: AdmissionReason;
  resetAt: string;
  quota?: AccountQuota;
};

export type AdmissionResult = AdmissionGrant | AdmissionRejection;

function positiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 1_000_000)
    : fallback;
}

/** Resolve the policy for one caller. Global overrides are read on every call. */
export function admissionLimits(userId: string | null): AdmissionLimits {
  const bucket = userId ? INFERENCE_POLICY.account : INFERENCE_POLICY.anonymous;
  return {
    principal: userId
      ? createHash("sha256").update(userId).digest("hex")
      : "anonymous",
    hourlyLimit: bucket.limit,
    concurrency: bucket.concurrency,
    globalDailyLimit: positiveLimit(
      process.env.CHAT_DAILY_REQUEST_LIMIT,
      INFERENCE_POLICY.global.dailyLimit,
    ),
    globalConcurrency: positiveLimit(
      process.env.CHAT_CONCURRENCY_LIMIT,
      INFERENCE_POLICY.global.concurrency,
    ),
  };
}

/**
 * IETF RateLimit fields (draft-ietf-httpapi-ratelimit-headers) for an account quota. Returns no
 * headers without a quota, so anonymous responses never describe the shared bucket.
 */
export function rateLimitHeaders(
  quota: AccountQuota | undefined,
  now = Date.now(),
): Record<string, string> {
  if (!quota) return {};
  const reset = Math.max(
    0,
    Math.ceil((Date.parse(quota.resetAt) - now) / 1000),
  );
  return {
    "RateLimit-Policy": `"account";q=${quota.limit};w=${INFERENCE_POLICY.account.windowSeconds}`,
    RateLimit: `"account";r=${quota.remaining};t=${reset}`,
  };
}
