import { createHash } from "node:crypto";
import { claimChatAdmission } from "@/lib/server-db";

function positiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 1_000_000)
    : fallback;
}

/** Shared chat/analysis quota. userId is the stable application owner resolved from WorkOS.
 * Anonymous clients share a bucket; no spoofable IP header or resettable cookie bypasses it.
 * Keep the existing CHAT_* configuration names for deployment compatibility.
 */
function admitInference(userId: string | null) {
  return claimChatAdmission({
    principal: userId
      ? createHash("sha256").update(userId).digest("hex")
      : "anonymous",
    hourlyLimit: userId ? 30 : 10,
    concurrency: userId ? 2 : 1,
    globalDailyLimit: positiveLimit(
      process.env.CHAT_DAILY_REQUEST_LIMIT,
      1_000,
    ),
    globalConcurrency: positiveLimit(process.env.CHAT_CONCURRENCY_LIMIT, 8),
  });
}

export const admitChat = admitInference;
export function admitAnalysis(userId: string) {
  return admitInference(userId);
}
