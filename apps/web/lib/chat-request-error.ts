import { isRecord } from "@/lib/utils";
import {
  admissionRejectionMessage,
  parseAdmissionRejection,
} from "@/lib/usage-client";

export function chatRequestFailure(
  payload: unknown,
  status: number,
  retryAfter: string | null,
  now = Date.now(),
) {
  const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  const delay =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Number.isFinite(date)
        ? Math.max(0, date - now)
        : 0;
  // A 429 names the limit and its reset; hourly and daily limits are reworded in local time.
  const rejection = status === 429 ? parseAdmissionRejection(payload) : null;
  const message =
    status === 401
      ? "Your session has expired. Sign in to continue."
      : (rejection && admissionRejectionMessage(rejection, now)) ||
        (isRecord(payload) &&
        typeof payload.error === "string" &&
        payload.error.trim()
          ? payload.error.slice(0, 500)
          : status === 429
            ? "The usage limit has been reached. Please try again later."
            : status === 409
              ? "A reply is already running in this chat. Please wait for it to finish."
              : "Chat is temporarily unavailable. Please try again.");
  return {
    message,
    status,
    retryAt: now + Math.min(delay, 86_400_000),
    ...(rejection
      ? { reason: rejection.reason, resetAt: rejection.resetAt }
      : {}),
    ...(rejection?.quota ? { quota: rejection.quota } : {}),
  };
}
