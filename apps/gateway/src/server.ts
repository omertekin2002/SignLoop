import { getServiceConfig } from "./config";
import { handleRequest, toProviderConfig } from "./handler";
import { listProviderCandidates } from "./pipeline/agent-provider";

const config = getServiceConfig();

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

Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  fetch(request, server) {
    // Preserve Bun's transport guard while parsing headers, then allow grounded research to be
    // quiet between response bytes. The handler's abort-aware timeout governs from this point.
    server.timeout(request, 0);
    return handleRequest(request);
  },
});
