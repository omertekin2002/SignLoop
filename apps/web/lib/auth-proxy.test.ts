import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

let proxy: typeof import("../proxy").default;

beforeAll(async () => {
  // Exercise the real SDK's local session/PKCE logic. This public client identifier
  // is a test fixture; no WorkOS account, API key, or network request is used.
  vi.stubEnv("WORKOS_API_KEY", "");
  vi.stubEnv("WORKOS_CLIENT_ID", "client_signloop_test");
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", randomBytes(32).toString("hex"));
  vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "http://localhost:3000/callback");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  ({ default: proxy } = await import("../proxy"));
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function runProxy(path: string, headers?: HeadersInit, origin = "http://localhost:3000") {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "text/html");
  return (await proxy(new NextRequest(`${origin}${path}`, { headers: requestHeaders }), {} as never)) as Response;
}

describe("WorkOS route protection", () => {
  it.each(["/dashboard", "/settings", "/projects/123", "/contracts/123"])(
    "redirects a logged-out visit to %s with a PKCE cookie",
    async (path) => {
      const response = await runProxy(path);
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("Location")!);
      expect(location.hostname).toBe("api.workos.com");
      expect(location.searchParams.get("client_id")).toBe("client_signloop_test");
      expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("state")).toBeTruthy();
      expect(response.headers.get("Set-Cookie")).toContain("wos-auth-verifier");
      expect(response.headers.has("x-workos-session")).toBe(false);
    },
  );

  it.each(["/", "/api/chat", "/api/projects", "/api/cron/storage-cleanup", "/callback", "/sign-in", "/sign-up"])(
    "passes %s to its handler without a login redirect",
    async (path) => {
      const response = await runProxy(path);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.has("Location")).toBe(false);
      // Ordinary public requests must not accumulate PKCE cookies.
      expect(response.headers.has("Set-Cookie")).toBe(false);
    },
  );

  it("removes a forged internal session header before forwarding to API handlers", async () => {
    const response = await runProxy("/api/projects", {
      "x-workos-session": "forged-session",
      "x-workos-middleware": "true",
      "x-redirect-uri": "https://attacker.example/callback",
    });
    expect(response.headers.has("x-middleware-request-x-workos-session")).toBe(false);
    expect(response.headers.get("x-middleware-request-x-redirect-uri")).toBe("http://localhost:3000/callback");
  });
});

describe("WorkOS redirect URI on Vercel deployments", () => {
  const branchHost = "signloop-git-feature-omertekin2002-4243s-projects.vercel.app";
  const deploymentHost = "signloop-abc123xyz-omertekin2002-4243s-projects.vercel.app";

  function stubVercel(environment: string) {
    vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("VERCEL_BRANCH_URL", branchHost);
    vi.stubEnv("VERCEL_URL", deploymentHost);
  }

  afterEach(() => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_BRANCH_URL", "");
    vi.stubEnv("VERCEL_URL", "");
  });

  it.each([branchHost, deploymentHost])(
    "returns a preview sign-in to the host that started it (%s)",
    async (host) => {
      stubVercel("preview");
      const response = await runProxy("/dashboard", undefined, `https://${host}`);
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("redirect_uri")).toBe(`https://${host}/callback`);
      expect(response.headers.get("Set-Cookie")).toContain("Secure");
    },
  );

  it("forwards the preview callback to the sign-in route handler", async () => {
    stubVercel("preview");
    const response = await runProxy("/sign-in", undefined, `https://${branchHost}`);
    expect(response.headers.get("x-middleware-request-x-redirect-uri")).toBe(
      `https://${branchHost}/callback`,
    );
  });

  it("falls back to the deployment URL instead of trusting an unknown Host", async () => {
    stubVercel("preview");
    const response = await runProxy("/dashboard", undefined, "https://attacker.example");
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(`https://${deploymentHost}/callback`);
  });

  it("keeps the configured redirect URI in production", async () => {
    stubVercel("production");
    const response = await runProxy("/dashboard", undefined, `https://${deploymentHost}`);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback");
  });
});
