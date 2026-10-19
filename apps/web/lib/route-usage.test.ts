import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, claimChatAdmission, getInferenceQuota } = vi.hoisted(() => ({
  auth: vi.fn(),
  claimChatAdmission: vi.fn(),
  getInferenceQuota: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({ claimChatAdmission, getInferenceQuota }));

import { GET } from "@/app/api/usage/route";

const account = {
  limit: 30,
  used: 18,
  remaining: 12,
  resetAt: "2026-10-19T15:00:00.000Z",
  concurrency: { limit: 2, inUse: 1 },
};

beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ userId: "owner" });
  getInferenceQuota.mockResolvedValue({ account, service: "ok" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/usage", () => {
  it("requires sign-in and reads nothing for anonymous callers", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getInferenceQuota).not.toHaveBeenCalled();
  });

  it("reports the owner's quota without claiming any, uncached", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      account,
      shared: ["chat", "analysis"],
      service: "ok",
    });
    expect(getInferenceQuota).toHaveBeenCalledExactlyOnceWith("owner");
    expect(claimChatAdmission).not.toHaveBeenCalled();
  });

  it("adds the account's RateLimit fields", async () => {
    const response = await GET();

    expect(response.headers.get("RateLimit-Policy")).toBe(
      '"account";q=30;w=3600',
    );
    expect(response.headers.get("RateLimit")).toMatch(/^"account";r=12;t=\d+$/);
  });

  it("exposes only the coarse service status, never service-wide counts", async () => {
    getInferenceQuota.mockResolvedValue({
      account,
      service: "busy",
      active: 8,
      daily: 987,
    });

    const body = await (await GET()).json();

    expect(Object.keys(body).sort()).toEqual(["account", "service", "shared"]);
    expect(body.service).toBe("busy");
    expect(JSON.stringify(body)).not.toMatch(/987|"active"|"daily"/);
  });

  it("returns an uncached 503 when the quota cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    getInferenceQuota.mockRejectedValue(new Error("db down"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("RateLimit")).toBeNull();
    expect(claimChatAdmission).not.toHaveBeenCalled();
  });
});
