import { defineConfig, devices } from "@playwright/test";
import { E2E_ORIGIN, E2E_PORT, E2E_SERVER_ENV } from "./e2e/placeholder-env";

// Playwright runs outside Turbo, so CI needs no turbo.json entry.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const isCI = Boolean(process.env.CI);

// Smoke tests against the production build. Run `bun run build` first; `next start` fails fast
// without one. The server gets placeholder configuration and needs no database or model provider.
export default defineConfig({
  testDir: "./e2e",
  // The signed-in suite needs real credentials and a database: playwright.signed-in.config.ts.
  testIgnore: "signed-in/**",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bunx next start --hostname 127.0.0.1 --port ${E2E_PORT}`,
    url: `${E2E_ORIGIN}/privacy`,
    // Never reuse a server started with other configuration; the assertions depend on these values.
    reuseExistingServer: false,
    timeout: 60_000,
    env: E2E_SERVER_ENV,
  },
});
