import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

async function runProxy(path: string, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "text/html");
  return (await proxy(new NextRequest(`http://localhost:3000${path}`, { headers: requestHeaders }), {} as never)) as Response;
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
