// Adapted from SignLoop apps/web/lib/utils.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776

/** Narrow an unknown value to a non-null object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract a useful internal message without making it suitable for public output. */
export function getErrorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  if (fallback !== undefined) return fallback;
  return String(error);
}
