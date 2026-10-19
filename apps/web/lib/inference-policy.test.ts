import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  admissionLimits,
  INFERENCE_POLICY,
  rateLimitHeaders,
  type AccountQuota,
} from "./inference-policy";

const resetAt = "2026-10-19T15:00:00.000Z";
const quota: AccountQuota = {
  limit: 30,
  used: 18,
  remaining: 12,
  resetAt,
  concurrency: { limit: 2, inUse: 0 },
};

describe("rateLimitHeaders", () => {
  it("formats the IETF account policy and remaining quota", () => {
    expect(rateLimitHeaders(quota, Date.parse(resetAt) - 900_000)).toEqual({
      "RateLimit-Policy": '"account";q=30;w=3600',
      RateLimit: '"account";r=12;t=900',
    });
  });

  it("rounds the reset up to whole seconds and never reports a negative one", () => {
    expect(rateLimitHeaders(quota, Date.parse(resetAt) - 1_200).RateLimit).toBe(
      '"account";r=12;t=2',
    );
    expect(rateLimitHeaders(quota, Date.parse(resetAt) + 5_000).RateLimit).toBe(
      '"account";r=12;t=0',
    );
  });

  it("describes nothing without an account quota", () => {
    expect(rateLimitHeaders(undefined)).toEqual({});
  });
});

describe("admissionLimits", () => {
  it("resolves accounts and the anonymous bucket from the one policy", () => {
    expect(admissionLimits("user_123")).toMatchObject({
      principal: createHash("sha256").update("user_123").digest("hex"),
      hourlyLimit: INFERENCE_POLICY.account.limit,
      concurrency: INFERENCE_POLICY.account.concurrency,
    });
    expect(admissionLimits(null)).toMatchObject({
      principal: "anonymous",
      hourlyLimit: INFERENCE_POLICY.anonymous.limit,
      concurrency: INFERENCE_POLICY.anonymous.concurrency,
    });
  });
});
