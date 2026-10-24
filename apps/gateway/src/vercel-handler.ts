import { randomUUID } from "node:crypto";

import { loadServiceConfig, type ServiceConfig } from "./config";
import {
  createRequestHandler,
  normalizeRequestId,
  requestPath,
  type RequestHandlerOptions,
  type StructuredLogSink,
} from "./handler";
import { logServiceStartup } from "./startup-log";

/**
 * The function's maximum duration on Vercel (the Hobby plan maximum with Fluid compute).
 * scripts/build-vercel.ts writes it into the function configuration.
 */
export const VERCEL_MAX_DURATION_SECONDS = 300;

export type FetchHandler = Readonly<{
  fetch: (request: Request) => Promise<Response>;
}>;

export type VercelHandlerOptions = Omit<RequestHandlerOptions, "config">;

type Environment = Readonly<Record<string, string | undefined>>;

function consoleLog(entry: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify(entry));
}

/**
 * Every request, `/healthz` included, gets a 503 while the configuration is invalid, so health
 * checks and callers see the failure instead of an opaque crash on each cold start.
 */
function createUnconfiguredHandler(
  options: VercelHandlerOptions,
): FetchHandler {
  const configuredLog = options.log ?? consoleLog;
  const log: StructuredLogSink = (entry) => {
    try {
      configuredLog(entry);
    } catch {
      // Logging must never change an HTTP result.
    }
  };
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return {
    async fetch(request) {
      const requestId =
        normalizeRequestId(request.headers.get("x-request-id")) ??
        requestIdFactory();
      log({
        requestId,
        route: requestPath(request),
        status: 503,
        durationMs: 0,
        errorClass: "ConfigurationError",
      });
      return new Response(
        JSON.stringify({
          error: "Chat service is not configured.",
          code: "service_unavailable",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Request-ID": requestId,
          },
        },
      );
    },
  };
}

/**
 * Build the Vercel Function handler once per instance (the local dev server builds one too).
 * Configuration is validated here, at module load; the per-instance concurrency limit lives in the
 * handler this creates.
 */
export function createVercelHandler(
  environment: Environment = process.env,
  options: VercelHandlerOptions = {},
): FetchHandler {
  let config: ServiceConfig;
  try {
    config = loadServiceConfig(environment);
  } catch (error) {
    // Configuration errors name the variable and never include its value.
    console.error(
      JSON.stringify({
        level: "error",
        event: "config_invalid",
        message:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "Invalid configuration",
      }),
    );
    return createUnconfiguredHandler(options);
  }

  logServiceStartup(config);
  if (config.requestTimeoutMs >= VERCEL_MAX_DURATION_SECONDS * 1000) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "request_timeout_exceeds_max_duration",
        requestTimeoutMs: config.requestTimeoutMs,
        maxDurationMs: VERCEL_MAX_DURATION_SECONDS * 1000,
      }),
    );
  }

  const handler = createRequestHandler({ ...options, config });
  return { fetch: (request) => handler(request) };
}
