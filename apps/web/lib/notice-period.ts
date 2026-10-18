/** Only exact, whole calendar-day durations can populate the numeric convenience field. */
export function calendarNoticeDays(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)(?:\s+(?:calendar\s+)?days?)?$/i);
  return match ? calendarNoticeDays(Number(match[1])) : null;
}

export function normalizeNoticePeriod(days: unknown, wording: unknown) {
  const text =
    typeof wording === "string" && wording.trim()
      ? wording.trim()
      : typeof days === "string" && days.trim()
        ? days.trim()
        : null;
  if (text) {
    return {
      notice_period_days: calendarNoticeDays(text),
      notice_period_text: text,
    };
  }
  if (days === null || (wording === null && days === undefined)) {
    return { notice_period_days: null, notice_period_text: null };
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
    notice.notice_period_text?.trim() ||
    (typeof notice.notice_period_days === "number"
      ? `${notice.notice_period_days} days`
      : "Not specified")
  );
}
