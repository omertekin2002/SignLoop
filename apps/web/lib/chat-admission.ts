import { createHash } from "node:crypto";
import { claimChatAdmission } from "@/lib/server-db";

function positiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 1_000_000)
    : fallback;
}

/** Anonymous clients share a bucket; no spoofable IP header or resettable cookie bypasses it. */
export function admitChat(userId: string | null) {
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
