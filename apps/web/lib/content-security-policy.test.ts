import { describe, expect, it } from "vitest";
import {
  CSP_REPORT_PATH,
  contentSecurityPolicy,
  contentSecurityPolicyDirectives,
} from "@/lib/content-security-policy.js";
import nextConfig from "@/next.config.js";

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...sources] = directive.split(" ");
      return [name, sources];
    }),
  );

describe("contentSecurityPolicy", () => {
  it("allows only the app's own origin and the Vercel Blob upload API in production", () => {
    expect(directives(contentSecurityPolicy({ dev: false }))).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:"],
      "font-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://vercel.com"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'self'"],
      "report-uri": [CSP_REPORT_PATH],
    });
  });

  it("adds 'unsafe-eval' to script-src only in development", () => {
    expect(contentSecurityPolicy({ dev: false })).not.toContain("'unsafe-eval'");
    expect(contentSecurityPolicyDirectives({ dev: true })["script-src"]).toEqual([
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
    ]);
  });
});

describe("next.config.js headers", () => {
  const headersFor = async (phase: string) => {
    const rules = await nextConfig(phase).headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
    return Object.fromEntries(rules[0]!.headers.map(({ key, value }) => [key, value]));
  };

  it("sends the policy report-only, never enforced", async () => {
    const headers = await headersFor("phase-production-build");
    expect(headers["Content-Security-Policy-Report-Only"]).toBe(
      contentSecurityPolicy({ dev: false }),
    );
    expect(headers).not.toHaveProperty("Content-Security-Policy");
  });

  it("uses the development policy only under next dev", async () => {
    expect((await headersFor("phase-development-server"))["Content-Security-Policy-Report-Only"])
      .toContain("'unsafe-eval'");
    expect((await headersFor("phase-production-server"))["Content-Security-Policy-Report-Only"])
      .not.toContain("'unsafe-eval'");
  });
});
