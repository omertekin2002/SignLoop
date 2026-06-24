import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Coerce an unknown value (string | Date | nullish) to a valid Date, or null if it isn't one.
export function coerceDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Safely format a date-ish value with a date-fns format string, returning `fallback` when the
// value is missing or invalid. Replaces per-page formatDate/`format(new Date(...))` duplicates.
export function formatDate(value: unknown, formatStr: string, fallback = ""): string {
  const date = coerceDate(value);
  return date ? format(date, formatStr) : fallback;
}

// Render a byte count as "X.XX MB" (the format used in the upload dialog and project pages).
export function formatFileSize(bytes: number | null | undefined): string {
  const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

// Narrow an unknown value to a plain object. Shared guard reused across the LLM/chat/parsing code
// (previously reimplemented in model-settings, chat, the chat route, and analysis).
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
        ? "bg-amber-500/15 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
        : "bg-amber-500/15 text-amber-800 dark:text-amber-200";
    case "low":
      return hover
        ? "bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/20 dark:text-emerald-200"
        : "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    default:
      return hover ? "bg-muted text-muted-foreground hover:bg-muted" : "bg-muted text-muted-foreground";
  }
}
