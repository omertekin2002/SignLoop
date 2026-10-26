import { neonConfig } from "@neondatabase/serverless";

type ProxyConfig = Pick<
  typeof neonConfig,
  "wsProxy" | "useSecureWebSocket" | "pipelineTLS" | "pipelineConnect" | "fetchEndpoint"
>;

// @vercel/postgres reaches PostgreSQL through the Neon driver: pooled queries (sql.query, connect)
// travel over a WebSocket, and tagged-template queries (sql`...`) over HTTPS. A plain local
// PostgreSQL, such as the signed-in end-to-end suite's database, speaks neither, so
// POSTGRES_LOCAL_PROXY names the host:port of a local unencrypted proxy that does
// (e2e/neon-local-proxy.ts). Deployments never set it, and it is refused for any database not on
// localhost, which is also the only non-Neon host @vercel/postgres accepts.
export function configurePostgresLocalProxy(
  env: Record<string, string | undefined> = process.env,
  config: ProxyConfig = neonConfig,
): void {
  const proxy = env.POSTGRES_LOCAL_PROXY;
  if (!proxy) return;
  if (!isLocalhostDatabase(env.POSTGRES_URL)) {
    throw new Error("POSTGRES_LOCAL_PROXY is only allowed when POSTGRES_URL points at localhost");
  }
  // The driver adds the WebSocket protocol and appends ?address=host:port itself.
  config.wsProxy = `${proxy}/v1`;
  config.useSecureWebSocket = false;
  config.pipelineTLS = false;
  // Pipelining assumes cleartext password authentication; a local server may use any method.
  config.pipelineConnect = false;
  config.fetchEndpoint = `http://${proxy}/sql`;
}

function isLocalhostDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "localhost";
  } catch {
    return false;
  }
}

configurePostgresLocalProxy();
