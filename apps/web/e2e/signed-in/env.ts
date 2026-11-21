import os from "node:os";
import path from "node:path";
import { E2E_PORT } from "../placeholder-env";
import { STUB_MODEL } from "../stub-model-server";

// AuthKit's callback redirects to the host Next.js reports for the request, and `next start` reports
// a loopback request as localhost. The suite therefore browses localhost (the server still listens
// on 127.0.0.1 only), so the session cookie set by the callback reaches the dashboard.
export const SIGNED_IN_ORIGIN = `http://localhost:${E2E_PORT}`;
export const SIGNED_IN_REDIRECT_URI = `${SIGNED_IN_ORIGIN}/callback`;

// Configuration for the signed-in suite (playwright.signed-in.config.ts). The WorkOS values belong
// to a dedicated staging environment whose redirect URI is SIGNED_IN_REDIRECT_URI and whose
// sign-out URI is SIGNED_IN_ORIGIN/; the test user signs in with email and password and has no
// real data. CI reads them from repository secrets of the same names and points E2E_DATABASE_URL
// at an empty PostgreSQL service container.
const REQUIRED = [
  "E2E_WORKOS_API_KEY",
  "E2E_WORKOS_CLIENT_ID",
  "E2E_WORKOS_COOKIE_PASSWORD",
  "E2E_USER_EMAIL",
  "E2E_USER_PASSWORD",
  "E2E_DATABASE_URL",
] as const;

type SignedInEnv = Record<(typeof REQUIRED)[number], string>;

export function signedInEnv(): SignedInEnv {
  const env = process.env;
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`The signed-in end-to-end suite needs ${missing.join(", ")}`);
  }
  const values = Object.fromEntries(REQUIRED.map((name) => [name, env[name]!])) as SignedInEnv;
  // The suite migrates and writes to this database. @vercel/postgres accepts no non-Neon host but
  // localhost, and the Neon driver's HTTP queries require a password in the URL (with trust
  // authentication, any password works).
  const database = new URL(values.E2E_DATABASE_URL);
  if (database.hostname !== "localhost" || !database.password) {
    throw new Error(
      "E2E_DATABASE_URL must be a disposable PostgreSQL database on localhost, with a password",
    );
  }
  return values;
}

// The app reaches E2E_DATABASE_URL through e2e/neon-local-proxy.ts on this port.
export const E2E_DATABASE_PROXY_PORT = 3101;

// The app's model provider is e2e/stub-model-server.ts on this port: no real provider, key or
// network call. OpenRouter, web search and image generation stay unconfigured.
export const E2E_MODEL_STUB_PORT = 3102;
export const E2E_MODEL_STUB_URL = `http://127.0.0.1:${E2E_MODEL_STUB_PORT}`;

// Model, search, page-reading and tracing credentials the suite must never use.
const UNCONFIGURED = [
  "PRIMARY_LLM_API_KEY",
  "OPENROUTER_API_KEY",
  "WEB_SEARCH_PROVIDER",
  "BRAVE_SEARCH_API_KEY",
  "FIRECRAWL_API_KEY",
  "GEMINI_API_KEY",
  "JINA_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
];

export const AUTH_STATE_PATH = "playwright/.auth/signed-in.json";

export function signedInServerEnv(env: SignedInEnv): Record<string, string> {
  return {
    WORKOS_API_KEY: env.E2E_WORKOS_API_KEY,
    WORKOS_CLIENT_ID: env.E2E_WORKOS_CLIENT_ID,
    WORKOS_COOKIE_PASSWORD: env.E2E_WORKOS_COOKIE_PASSWORD,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: SIGNED_IN_REDIRECT_URI,
    POSTGRES_URL: env.E2E_DATABASE_URL,
    POSTGRES_LOCAL_PROXY: `127.0.0.1:${E2E_DATABASE_PROXY_PORT}`,
    // No Blob token, so uploads take the multipart path and land in local storage, which a
    // production build accepts only from an explicit directory.
    LOCAL_STORAGE_PATH: path.join(os.tmpdir(), "signloop-e2e-uploads"),
    PRIMARY_LLM_BASE_URL: E2E_MODEL_STUB_URL,
    PRIMARY_LLM_MODEL: STUB_MODEL,
    // Empty values win over an apps/web/.env.local that `next start` would otherwise load, so a
    // local run reaches no real provider or search service either.
    ...Object.fromEntries(UNCONFIGURED.map((name) => [name, ""])),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}
