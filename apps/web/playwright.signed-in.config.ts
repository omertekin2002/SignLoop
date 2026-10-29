import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT } from "./e2e/placeholder-env";
import {
  AUTH_STATE_PATH,
  SIGNED_IN_ORIGIN,
  signedInEnv,
  signedInServerEnv,
} from "./e2e/signed-in/env";

// Playwright runs outside Turbo, so CI needs no turbo.json entry.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const isCI = Boolean(process.env.CI);

// Signed-in end-to-end tests against the production build: a real WorkOS sign-in through AuthKit's
// hosted page, then the workspace backed by an empty local PostgreSQL. Run `bun run build` first.
// The variables signedInEnv() lists are required; see the README.
export default defineConfig({
  testDir: "./e2e/signed-in",
  // The projects run in order and share one WorkOS session, which the last one ends.
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 60_000,
  // Separate from the smoke suite's folders so one run never clears the other's report.
  outputDir: "test-results/signed-in",
  reporter: isCI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report/signed-in" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report/signed-in" }]],
  globalSetup: "./e2e/signed-in/global-setup.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: SIGNED_IN_ORIGIN,
    // CI uploads failure reports as a public artifact, and a trace of a signed-in test records the
    // session cookie on every request. Traces stay local; CI keeps screenshots, which show none.
    trace: isCI ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "sign-in",
      testMatch: "sign-in.setup.ts",
      // Never record the password step, even locally (the setup also enters credentials without
      // creating report steps).
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "workspace",
      // Files run in name order, so the accessibility scans see the still-empty account first.
      testMatch: ["a11y.spec.ts", "workspace.spec.ts"],
      dependencies: ["sign-in"],
      use: { storageState: AUTH_STATE_PATH },
    },
    {
      // After the workspace checks, which expect an account without contracts.
      name: "csp",
      testMatch: "csp.spec.ts",
      dependencies: ["workspace"],
      use: { storageState: AUTH_STATE_PATH },
    },
    {
      name: "sign-out",
      testMatch: "sign-out.spec.ts",
      dependencies: ["csp"],
      use: { storageState: AUTH_STATE_PATH },
    },
  ],
  webServer: {
    command: `bunx next start --hostname 127.0.0.1 --port ${E2E_PORT}`,
    url: `${SIGNED_IN_ORIGIN}/privacy`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: signedInServerEnv(signedInEnv()),
  },
});
