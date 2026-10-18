import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { claimChatAdmission } = vi.hoisted(() => ({
  claimChatAdmission: vi.fn(),
}));

vi.mock("@/lib/server-db", () => ({ claimChatAdmission }));

import { admitChat, admitAnalysis } from "@/lib/chat-admission";

const ENV_KEYS = [
  "CHAT_DAILY_REQUEST_LIMIT",
  "CHAT_CONCURRENCY_LIMIT",
] as const;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = {
    CHAT_DAILY_REQUEST_LIMIT: process.env.CHAT_DAILY_REQUEST_LIMIT,
    CHAT_CONCURRENCY_LIMIT: process.env.CHAT_CONCURRENCY_LIMIT,
  };
  for (const key of ENV_KEYS) delete process.env[key];
  claimChatAdmission.mockResolvedValue({
    release: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.resetAllMocks();
});

function claimedInput() {
  expect(claimChatAdmission).toHaveBeenCalledOnce();
  return claimChatAdmission.mock.calls[0]![0];
}

describe("admitChat", () => {
  it("keys signed-in users by a sha256 of their id with the signed-in limits", async () => {
    await admitChat("user_123");

    expect(claimedInput()).toEqual({
      principal: createHash("sha256").update("user_123").digest("hex"),
      hourlyLimit: 30,
      concurrency: 2,
      globalDailyLimit: 1_000,
      globalConcurrency: 8,
    });
  });

  it("never sends the raw user id as the principal", async () => {
    await admitChat("user_123");

    const { principal } = claimedInput();
    expect(principal).not.toContain("user_123");
    expect(principal).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives distinct users distinct principals", async () => {
    await admitChat("user_a");
    await admitChat("user_b");

    const [first, second] = claimChatAdmission.mock.calls.map(
      ([input]) => input.principal,
    );
    expect(first).not.toBe(second);
  });

  it("puts every anonymous visitor in one shared bucket with the anonymous limits", async () => {
    await admitChat(null);

    expect(claimedInput()).toEqual({
      principal: "anonymous",
      hourlyLimit: 10,
      concurrency: 1,
      globalDailyLimit: 1_000,
      globalConcurrency: 8,
    });
  });

  it("treats an empty user id as anonymous", async () => {
    await admitChat("");

    expect(claimedInput()).toMatchObject({
      principal: "anonymous",
      hourlyLimit: 10,
      concurrency: 1,
    });
  });

  it.each([
    [{ release: expect.any(Function) }, undefined],
    [{ retryAfter: 30 }, { retryAfter: 30 }],
    [{ retryAfter: 3600 }, { retryAfter: 3600 }],
    [{ retryAfter: 86400 }, { retryAfter: 86400 }],
  ])("returns the claim result unchanged (%o)", async (expected, resolved) => {
    if (resolved) claimChatAdmission.mockResolvedValue(resolved);

    await expect(admitChat("user_123")).resolves.toEqual(expected);
  });

  it("propagates a failed claim so the route can fail closed", async () => {
    claimChatAdmission.mockRejectedValue(new Error("db down"));

    await expect(admitChat(null)).rejects.toThrow("db down");
  });
});

describe.each([
  ["CHAT_DAILY_REQUEST_LIMIT", "globalDailyLimit", 1_000],
  ["CHAT_CONCURRENCY_LIMIT", "globalConcurrency", 8],
] as const)("%s parsing", (envKey, field, fallback) => {
  it("uses the default when unset", async () => {
    await admitChat("user_123");

    expect(claimedInput()[field]).toBe(fallback);
  });

  it.each(["", "0", "-1", "1.5", "abc", "NaN", "Infinity", "9007199254740993"])(
    "falls back to the default for %j",
    async (value) => {
      process.env[envKey] = value;

      await admitChat("user_123");

      expect(claimedInput()[field]).toBe(fallback);
    },
  );

  it.each([
    ["1", 1],
    ["25", 25],
    [" 42 ", 42],
    ["1000000", 1_000_000],
  ])("accepts %j as %i", async (value, expected) => {
    process.env[envKey] = value;

    await admitChat("user_123");

    expect(claimedInput()[field]).toBe(expected);
  });

  it("clamps oversized values to 1,000,000", async () => {
    process.env[envKey] = "2000000";

    await admitChat(null);

    expect(claimedInput()[field]).toBe(1_000_000);
  });

  it("reads the environment on every call", async () => {
    process.env[envKey] = "5";
    await admitChat("user_123");
    process.env[envKey] = "7";
    await admitChat("user_123");

    expect(
      claimChatAdmission.mock.calls.map(([input]) => input[field]),
    ).toEqual([5, 7]);
  });
});

it("shares account and global budgets between chat and analysis", async () => {
  const owner = "a84e8ac1-bda9-450c-a756-30972398b529";
  await admitChat(owner);
  await admitAnalysis(owner);
  expect(claimChatAdmission.mock.calls[1]?.[0]).toEqual(
    claimChatAdmission.mock.calls[0]?.[0],
  );
});
