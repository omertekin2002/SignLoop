import { startNeonLocalProxy } from "../neon-local-proxy";
import { startStubModelServer } from "../stub-model-server";
import { E2E_DATABASE_PROXY_PORT, E2E_MODEL_STUB_PORT, signedInEnv } from "./env";

// Starts the proxy the server's database driver needs and the stub model it chats with; the
// returned function stops both after the run. Playwright starts the web server first, but the app
// reaches neither until a test signs in.
export default async function globalSetup() {
  const proxy = await startNeonLocalProxy(E2E_DATABASE_PROXY_PORT, signedInEnv().E2E_DATABASE_URL);
  const model = await startStubModelServer(E2E_MODEL_STUB_PORT).catch(async (error: unknown) => {
    await proxy.close();
    throw error;
  });
  return async () => {
    await model.close();
    await proxy.close();
  };
}
