/** Narrow an unknown value to a plain object; arrays are excluded. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A human-readable message from an unknown thrown value. */
export function getErrorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  if (fallback !== undefined) return fallback;
  return String(error);
}
