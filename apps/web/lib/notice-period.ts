import { isSubstantiveText } from "@/lib/substantive-text";

/** Only exact, whole calendar-day durations can populate the numeric convenience field. */
export function calendarNoticeDays(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)(?:\s+(?:calendar\s+)?days?)?$/i);
  return match ? calendarNoticeDays(Number(match[1])) : null;
}

function substantiveWording(value: unknown): string | null {
  return typeof value === "string" && isSubstantiveText(value)
    ? value.trim()
    : null;
}

// "Not specified" and similar mark the duration unknown; they are not wording to preserve.
function isPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && !isSubstantiveText(value);
}

/**
 * Original wording stays authoritative because only it carries units such as business days or
 * months. A placeholder never hides an explicit day count, and null means the provider marked the
 * duration unknown. Returns null when no usable or explicitly unknown value was supplied.
 */
export function normalizeNoticePeriod(days: unknown, wording: unknown) {
  const numericDayString = typeof days === "string" && /^\d+$/.test(days.trim());
  const text =
    substantiveWording(wording) ??
    (numericDayString ? null : substantiveWording(days));
  if (text) {
    return {
      notice_period_days: calendarNoticeDays(text),
      notice_period_text: text,
    };
  }
  if (days === undefined || days === null || isPlaceholder(days)) {
    return days === null || wording === null || isPlaceholder(days) || isPlaceholder(wording)
      ? { notice_period_days: null, notice_period_text: null }
      : null;
  }
  const parsed = calendarNoticeDays(days);
  return parsed === null
    ? null
    : { notice_period_days: parsed, notice_period_text: null };
}

export function formatNoticePeriod(notice: {
  notice_period_days?: number | null;
  notice_period_text?: string | null;
}): string {
  return (
    substantiveWording(notice.notice_period_text) ||
    (typeof notice.notice_period_days === "number"
      ? `${notice.notice_period_days} days`
      : "Not specified")
  );
}
