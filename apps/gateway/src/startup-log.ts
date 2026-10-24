import type { ServiceConfig } from "./config";
import { toProviderConfig } from "./handler";
import { listProviderCandidates } from "./pipeline/agent-provider";

/** Log the configured provider order once per process (Bun server or Vercel instance). */
export function logServiceStartup(config: ServiceConfig): void {
  // Provider names and model IDs only: credentials and endpoint URLs never reach the logs.
  console.log(
    JSON.stringify({
      level: "info",
      event: "generation_providers",
      providers: listProviderCandidates(toProviderConfig(config)).map(
        ({ provider, model }) => `${provider}:${model}`,
      ),
    }),
  );

  if (config.primaryLlm?.modelWasDefaulted) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "primary_model_defaulted",
        provider: "primary-openai-compatible",
        model: config.primaryLlm.model,
      }),
    );
  }
}
