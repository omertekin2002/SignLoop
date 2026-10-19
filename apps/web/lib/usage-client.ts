import { useQuery, type QueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import type {
  AccountQuota,
  AdmissionReason,
  ServiceStatus,
  UsageResponse,
} from "@/lib/inference-policy";
import { formatDate, isRecord } from "@/lib/utils";

// Client side of GET /api/usage and the quota that chat and analysis responses carry.

export const USAGE_QUERY_KEY = ["usage"] as const;

/** The chat composer starts counting down at this many remaining requests. */
export const LOW_USAGE_REMAINING = 5;

const SERVICE_STATUSES: readonly ServiceStatus[] = ["ok", "busy", "exhausted"];
const ADMISSION_REASONS: readonly AdmissionReason[] = [
  "busy",
  "hourly",
  "daily",
];

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function parseAccountQuota(value: unknown): AccountQuota | null {
  if (!isRecord(value) || !isRecord(value.concurrency)) return null;
  const { limit, used, remaining, resetAt } = value;
  const { limit: concurrencyLimit, inUse } = value.concurrency;
  return isCount(limit) &&
    isCount(used) &&
    isCount(remaining) &&
    isInstant(resetAt) &&
    isCount(concurrencyLimit) &&
    isCount(inUse)
    ? {
        limit,
        used,
        remaining,
        resetAt,
        concurrency: { limit: concurrencyLimit, inUse },
      }
    : null;
}

export function parseUsageResponse(value: unknown): UsageResponse | null {
  if (!isRecord(value)) return null;
  const account = parseAccountQuota(value.account);
  const service = SERVICE_STATUSES.find((status) => status === value.service);
  const shared = Array.isArray(value.shared)
    ? value.shared.filter(
        (item): item is "chat" | "analysis" =>
          item === "chat" || item === "analysis",
      )
    : [];
  return account && service ? { account, shared, service } : null;
}

export type AdmissionRejectionDetails = {
  reason: AdmissionReason;
  resetAt: string;
  quota: AccountQuota | null;
};

/** The reason, reset, and (for accounts) quota a 429 from chat or analysis carries. */
export function parseAdmissionRejection(
  payload: unknown,
): AdmissionRejectionDetails | null {
  if (!isRecord(payload)) return null;
  const reason = ADMISSION_REASONS.find((item) => item === payload.reason);
  return reason && isInstant(payload.resetAt)
    ? {
        reason,
        resetAt: payload.resetAt,
        quota: parseAccountQuota(payload.quota),
      }
    : null;
}

/** A reset in local wall-clock time, with the date when it falls on another day. */
export function formatResetTime(
  resetAt: string | number,
  now: number = Date.now(),
  timeZone?: string,
): string {
  const day = (value: string | number) =>
    formatDate(value, "yyyy MMM d", "", timeZone);
  return formatDate(
    resetAt,
    day(resetAt) === day(now) ? "HH:mm" : "MMM d, HH:mm",
    "",
    timeZone,
  );
}

/** "18 of 30 used this hour · resets 15:00 · shared by chat and analysis" */
export function describeUsage(
  quota: AccountQuota,
  now?: number,
  timeZone?: string,
): string {
  const used = Math.min(quota.used, quota.limit);
  return `${used} of ${quota.limit} used this hour · resets ${formatResetTime(quota.resetAt, now, timeZone)} · shared by chat and analysis`;
}

/** Meter fill tone: neutral, low at 20% or less remaining, empty at zero. */
export function usageMeterTone(
  quota: AccountQuota,
): "normal" | "low" | "empty" {
  if (quota.remaining === 0) return "empty";
  return quota.remaining <= quota.limit * 0.2 ? "low" : "normal";
}

/** Chat composer caption suffix: nothing until few requests remain; at zero, the reset time. */
export function composerUsageNote(
  quota: AccountQuota | undefined,
  now?: number,
  timeZone?: string,
): string {
  if (!quota || quota.remaining > LOW_USAGE_REMAINING) return "";
  return quota.remaining === 0
    ? `No requests left this hour · resets ${formatResetTime(quota.resetAt, now, timeZone)}`
    : `${quota.remaining} left this hour`;
}

/** Caption under the analysis buttons. */
export function analysisUsageNote(
  quota: AccountQuota | undefined,
  now?: number,
  timeZone?: string,
): string {
  if (!quota) return "";
  return quota.remaining === 0
    ? `No requests left this hour · resets ${formatResetTime(quota.resetAt, now, timeZone)} (shared with chat)`
    : `Uses 1 of ${quota.remaining} remaining (shared with chat)`;
}

/** Hourly and daily rejections in local time. Busy rejections return null: the server's wording stands. */
export function admissionRejectionMessage(
  rejection: AdmissionRejectionDetails,
  now?: number,
  timeZone?: string,
): string | null {
  const time = formatResetTime(rejection.resetAt, now, timeZone);
  if (rejection.reason === "hourly")
    return rejection.quota
      ? `You've used all ${rejection.quota.limit} requests this hour, shared by chat and analysis. They reset at ${time}.`
      : `The hourly request limit has been reached. It resets at ${time}.`;
  if (rejection.reason === "daily")
    return `SignLoop has reached its daily request limit. Please try again after ${time}.`;
  return null;
}

export async function fetchUsage(signal?: AbortSignal): Promise<UsageResponse> {
  const { data } = await apiClient.get<unknown>("/usage", { signal });
  const usage = parseUsageResponse(data);
  if (!usage) throw new Error("Usage response was malformed.");
  return usage;
}

// Refetch just after the window resets, so a zero-quota composer re-enables itself. If the
// database has not rolled over yet (client clock ahead), poll gently until it does.
const RESET_REFETCH_DELAY_MS = 2_000;
const STALE_WINDOW_POLL_MS = 30_000;

export function useUsage(enabled = true) {
  return useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: ({ signal }) => fetchUsage(signal),
    enabled,
    refetchInterval: (query) => {
      const resetAt = query.state.data?.account.resetAt;
      if (!resetAt) return false;
      const untilReset = Date.parse(resetAt) - Date.now();
      return untilReset > 0
        ? untilReset + RESET_REFETCH_DELAY_MS
        : STALE_WINDOW_POLL_MS;
    },
  });
}

// Responses can finish out of order; within one window, usage only grows.
function newerQuota(current: AccountQuota, next: AccountQuota): AccountQuota {
  const currentReset = Date.parse(current.resetAt);
  const nextReset = Date.parse(next.resetAt);
  if (currentReset !== nextReset)
    return nextReset > currentReset ? next : current;
  return next.used >= current.used ? next : current;
}

/**
 * Apply the quota a chat or analysis response carried after it finished or was rejected. The
 * cache updates in place and is only marked stale; without a quota, the usage query refetches.
 */
export function syncUsage(
  queryClient: QueryClient,
  quota?: AccountQuota | null,
): Promise<void> {
  if (quota)
    queryClient.setQueryData<UsageResponse>(USAGE_QUERY_KEY, (previous) =>
      previous
        ? { ...previous, account: newerQuota(previous.account, quota) }
        : previous,
    );
  return queryClient.invalidateQueries({
    queryKey: USAGE_QUERY_KEY,
    refetchType: quota ? "none" : "active",
  });
}
