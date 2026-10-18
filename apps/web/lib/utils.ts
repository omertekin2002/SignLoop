import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the Dala type scale and radii from tailwind.config.ts. Unknown `text-*`
// names are otherwise treated as colours, so `text-caption text-muted-foreground` would drop the size.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "caption",
            "nav-label",
            "body",
            "heading-2xs",
            "heading-xs",
            "subheading",
            "heading-sm",
            "heading",
            "heading-lg",
            "display",
          ],
        },
      ],
      rounded: [{ rounded: ["nav", "card", "button", "tag"] }],
      tracking: [{ tracking: ["display"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Coerce an unknown value (string | Date | nullish) to a valid Date, or null if it isn't one.
// ISO date-only strings parse as UTC midnight; display them through formatDate, which keeps the day.
export function coerceDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

// One-based month; hour and minute are zero for calendar dates.
type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

// ISO date-only strings ("2026-12-01", or the reduced "2026-12" and "2026") are calendar dates,
// such as contract terms. `new Date()` reads them as UTC midnight, so local time west of UTC would
// show the previous day.
const ISO_DATE_ONLY = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function calendarDateParts(match: RegExpExecArray): DateParts | null {
  const year = Number(match[1]);
  const month = Number(match[2] ?? 1);
  const day = Number(match[3] ?? 1);
  // Reject impossible days (2026-02-30) rather than rolling them into the next month as Date does.
  // setUTCFullYear, unlike Date.UTC, keeps years 0-99 literal.
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  return check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? { year, month, day, hour: 0, minute: 0 }
    : null;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

// The wall-clock fields of an instant in `timeZone`, or in the runtime's local zone when omitted.
function zonedParts(date: Date, timeZone: string | undefined): DateParts {
  let formatter = zonedFormatters.get(timeZone ?? "");
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    zonedFormatters.set(timeZone ?? "", formatter);
  }
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(date))
    parts[type] = Number(value);
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

function dateParts(
  value: unknown,
  timeZone: string | undefined,
): DateParts | null {
  const isoDate =
    typeof value === "string" ? ISO_DATE_ONLY.exec(value.trim()) : null;
  if (isoDate) return calendarDateParts(isoDate);
  const instant = coerceDate(value);
  return instant ? zonedParts(instant, timeZone) : null;
}

// Safely format a date-ish value, returning `fallback` when the value is missing or invalid.
// Supports the token subset the app uses (yyyy, MMMM, MMM, d, HH, mm) — a tiny, dependency-free
// replacement for date-fns `format`. Timestamps render in local time, or in `timeZone` (an IANA
// name) when given; ISO date-only strings render as the written calendar date in every zone.
export function formatDate(
  value: unknown,
  formatStr: string,
  fallback = "",
  timeZone?: string,
): string {
  const parts = dateParts(value, timeZone);
  if (!parts) return fallback;
  const { year, month, day, hour, minute } = parts;

  const replacements: Record<string, () => string> = {
    yyyy: () => String(year),
    MMMM: () => MONTHS_LONG[month - 1] ?? "",
    MMM: () => MONTHS_SHORT[month - 1] ?? "",
    HH: () => pad2(hour),
    mm: () => pad2(minute),
    d: () => String(day),
  };

  return formatStr.replace(
    /yyyy|MMMM|MMM|HH|mm|d/g,
    (token) => replacements[token]?.() ?? token,
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// True when `value` is a syntactically valid UUID. Used by dynamic API routes to 404 on malformed
// ids before they reach a uuid-typed SQL column (which would otherwise throw 22P02 → unhandled 500).
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Keep small uploads legible instead of displaying them as "0.00 MB".
export function formatFileSize(bytes: number | null | undefined): string {
  const value = Math.max(
    0,
    typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0,
  );
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

// Narrow an unknown value to a plain object. Shared guard reused across the LLM/chat/parsing code
// (previously reimplemented in model-settings, chat, the chat route, and analysis).
// Arrays are excluded: `typeof [] === "object"`, so without the check this predicate would claim an
// array is a Record and callers would read named properties that are always undefined.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Extract a human-readable message from an unknown thrown value. When the value is not an Error,
// returns `fallback` if given, otherwise String(error). Replaces the
// `error instanceof Error ? error.message : ...` idiom duplicated across routes and lib code.
export function getErrorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  if (fallback !== undefined) return fallback;
  return String(error);
}

// Tailwind classes for a contract risk badge (LOW/MEDIUM/HIGH). Pass { hover: true } to include
// hover-state variants (used where the badge sits in an interactive row).
export function getRiskColor(
  badge: string | null | undefined,
  options?: { hover?: boolean },
): string {
  const normalized = typeof badge === "string" ? badge.toLowerCase() : "";
  const hover = options?.hover ?? false;
  switch (normalized) {
    case "high":
      return hover
        ? "bg-destructive/15 text-destructive hover:bg-destructive/20"
        : "bg-destructive/15 text-destructive";
    case "medium":
      return hover
        ? "bg-highlight/15 text-highlight hover:bg-highlight/20"
        : "bg-highlight/15 text-highlight";
    case "low":
      return hover
        ? "bg-success/15 text-success hover:bg-success/20"
        : "bg-success/15 text-success";
    default:
      return hover
        ? "bg-muted text-muted-foreground hover:bg-muted"
        : "bg-muted text-muted-foreground";
  }
}
