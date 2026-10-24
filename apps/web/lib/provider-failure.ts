import type { LlmProvider } from "@/lib/llm-client";

/** The only provider-failure details allowed into logs: no messages, bodies, URLs, or prompts. */
export type SafeProviderFailure = Readonly<{
  provider: LlmProvider;
  model: string;
  errorClass: string;
  statusCode?: number;
  providerCode?: string;
  upstreamRequestId?: string;
}>;

function safeMachineValue(value: unknown, maximum = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return new RegExp(`^[A-Za-z0-9_.:-]{1,${maximum}}$`, "u").test(trimmed)
    ? trimmed
    : undefined;
}

function safeStatusCode(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

/** Reduce any SDK/provider error to allowlisted machine-readable fields before logging it. */
export function safeProviderFailureMetadata(
  provider: LlmProvider,
  model: string,
  error: unknown,
): SafeProviderFailure {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {};
  const headers = record.headers instanceof Headers ? record.headers : null;
  const errorClass =
    error instanceof Error ? error.name || "Error" : typeof error;
  const statusCode =
    safeStatusCode(record.status) ?? safeStatusCode(record.statusCode);
  const providerCode =
    safeMachineValue(record.code) ?? safeMachineValue(nested.code);
  const upstreamRequestId =
    safeMachineValue(record.request_id, 128) ??
    safeMachineValue(record.requestId, 128) ??
    safeMachineValue(record.requestID, 128) ??
    safeMachineValue(headers?.get("x-request-id"), 128);

  return {
    provider,
    model,
    errorClass: /^[A-Za-z0-9_.-]{1,100}$/u.test(errorClass)
      ? errorClass
      : "Error",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
  };
}
