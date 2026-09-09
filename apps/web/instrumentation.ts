/** Next.js instrumentation hook: wires AI SDK telemetry to Langfuse when credentials are configured. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getLangfuseSpanProcessor } = await import("./lib/telemetry");
  const processor = getLangfuseSpanProcessor();
  if (!processor) return;
  const [{ registerOTel }, { registerTelemetry }, { LangfuseVercelAiSdkIntegration }] =
    await Promise.all([
      import("@vercel/otel"),
      import("ai"),
      import("@langfuse/vercel-ai-sdk"),
    ]);
  registerOTel({ serviceName: "signloop-web", spanProcessors: [processor] });
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
}
