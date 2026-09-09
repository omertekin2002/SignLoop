import { LangfuseSpanProcessor } from "@langfuse/otel";

export const isTelemetryEnabled = Boolean(
  process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
);

const store = globalThis as typeof globalThis & {
  __signloopLangfuseSpanProcessor?: LangfuseSpanProcessor;
};

/** One processor per process, shared by the instrumentation and route bundles so flushes see every span. */
export function getLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
  if (!isTelemetryEnabled) return null;
  return (store.__signloopLangfuseSpanProcessor ??= new LangfuseSpanProcessor());
}

/** Serverless instances freeze after responding; export pending spans before that happens. */
export async function flushTelemetry(): Promise<void> {
  try {
    await getLangfuseSpanProcessor()?.forceFlush();
  } catch (error) {
    console.error("Telemetry flush failed:", error);
  }
}
