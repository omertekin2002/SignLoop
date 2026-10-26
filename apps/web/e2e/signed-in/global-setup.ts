import { startNeonLocalProxy } from "../neon-local-proxy";
import { E2E_DATABASE_PROXY_PORT, signedInEnv } from "./env";

// Starts the proxy the server's database driver needs; the returned function stops it after the run.
export default async function globalSetup() {
  const proxy = await startNeonLocalProxy(E2E_DATABASE_PROXY_PORT, signedInEnv().E2E_DATABASE_URL);
  return () => proxy.close();
}
