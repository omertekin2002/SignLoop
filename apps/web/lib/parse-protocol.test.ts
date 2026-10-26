import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PARSE_SIGNATURE_TTL_MS,
  parseRequestSchema,
  signParseRequest,
  verifyParseRequest,
} from "./parse-protocol";

const NOW = 1_800_000_000_000;
const request = {
  storageKey: "uploads/0b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d",
  mimeType: "application/pdf",
};

beforeEach(() => {
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "a-test-cookie-password-of-32-chars!!");
});
afterEach(() => vi.unstubAllEnvs());

describe("parse request signing", () => {
  it("accepts its own signature until it expires", () => {
    const signed = signParseRequest(request, NOW);

    expect(signed).toMatchObject({ ...request, expiresAt: NOW + PARSE_SIGNATURE_TTL_MS });
    expect(parseRequestSchema.parse(signed)).toEqual(signed);
    expect(verifyParseRequest(signed, NOW)).toBe(true);
    expect(verifyParseRequest(signed, NOW + PARSE_SIGNATURE_TTL_MS)).toBe(true);
    expect(verifyParseRequest(signed, NOW + PARSE_SIGNATURE_TTL_MS + 1)).toBe(false);
  });

  it("refuses an expiry further out than one TTL, even with a valid signature", () => {
    const signed = signParseRequest(request, NOW + 10 * PARSE_SIGNATURE_TTL_MS);
    expect(verifyParseRequest(signed, NOW)).toBe(false);
  });

  it.each([
    ["storage key", { storageKey: "uploads/1b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d" }],
    ["MIME type", { mimeType: "image/png" }],
    ["expiry", { expiresAt: NOW + 1_000 }],
  ])("refuses a signature when the %s was changed", (_label, change) => {
    const signed = signParseRequest(request, NOW);
    expect(verifyParseRequest({ ...signed, ...change }, NOW)).toBe(false);
  });

  it("refuses a different or truncated signature", () => {
    const signed = signParseRequest(request, NOW);
    const flipped = `${signed.signature[0] === "A" ? "B" : "A"}${signed.signature.slice(1)}`;
    expect(verifyParseRequest({ ...signed, signature: flipped }, NOW)).toBe(false);
    expect(verifyParseRequest({ ...signed, signature: signed.signature.slice(0, 20) }, NOW)).toBe(false);
    expect(parseRequestSchema.safeParse({ ...signed, signature: `${signed.signature}=` }).success).toBe(false);
  });

  it("refuses a signature made with another deployment's secret", () => {
    const signed = signParseRequest(request, NOW);
    vi.stubEnv("WORKOS_COOKIE_PASSWORD", "another-cookie-password-of-32-chars!");
    expect(verifyParseRequest(signed, NOW)).toBe(false);
  });

  it("derives its key rather than using the cookie password as the HMAC key", async () => {
    const { createHmac } = await import("node:crypto");
    const signed = signParseRequest(request, NOW);
    const naive = createHmac("sha256", "a-test-cookie-password-of-32-chars!!")
      .update(JSON.stringify(["POST /api/internal/parse", request.storageKey, request.mimeType, signed.expiresAt]))
      .digest("base64url");
    expect(signed.signature).not.toBe(naive);
  });

  it("cannot sign without the secret, and verifies nothing", () => {
    const signed = signParseRequest(request, NOW);
    vi.stubEnv("WORKOS_COOKIE_PASSWORD", "");
    expect(() => signParseRequest(request, NOW)).toThrow(/WORKOS_COOKIE_PASSWORD/);
    expect(verifyParseRequest(signed, NOW)).toBe(false);
  });
});
