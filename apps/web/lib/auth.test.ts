import { beforeEach, describe, expect, it, vi } from "vitest";

const { withAuth, resolveWorkOSUserId } = vi.hoisted(() => ({
  withAuth: vi.fn(),
  resolveWorkOSUserId: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth }));
vi.mock("@/lib/auth-identity", () => ({ resolveWorkOSUserId }));

import { auth } from "./auth";
import { requireUserId } from "./api-auth";

beforeEach(() => vi.resetAllMocks());

describe("application authentication", () => {
  it("allows anonymous session reads without database access", async () => {
    withAuth.mockResolvedValue({ user: null });
    expect(await auth()).toEqual({ userId: null });
    expect(withAuth).toHaveBeenCalledWith();
    expect(resolveWorkOSUserId).not.toHaveBeenCalled();
  });

  it("uses the mapped personal owner, regardless of organization claims", async () => {
    const user = { id: "user_workos", externalId: "legacy-owner" };
    withAuth.mockResolvedValue({ user, organizationId: "org_other", role: "admin" });
    resolveWorkOSUserId.mockResolvedValue("personal-owner");
    expect(await requireUserId()).toEqual({ userId: "personal-owner" });
    expect(resolveWorkOSUserId).toHaveBeenCalledExactlyOnceWith(user);
  });

  it("returns JSON 401 for a protected API rather than redirecting to a login form", async () => {
    withAuth.mockResolvedValue({ user: null });
    const result = await requireUserId();
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("Location")).toBeNull();
    expect(resolveWorkOSUserId).not.toHaveBeenCalled();
  });

  it("fails closed when identity persistence fails", async () => {
    withAuth.mockResolvedValue({ user: { id: "user_workos" } });
    resolveWorkOSUserId.mockRejectedValue(new Error("database unavailable"));
    await expect(auth()).rejects.toThrow("database unavailable");
  });
});
