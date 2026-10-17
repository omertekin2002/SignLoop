import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSignInUrl, getSignUpUrl, handleAuth, resolveWorkOSUserId } = vi.hoisted(() => ({
  getSignInUrl: vi.fn(),
  getSignUpUrl: vi.fn(),
  handleAuth: vi.fn((options) => options),
  resolveWorkOSUserId: vi.fn(),
}));
vi.mock("@workos-inc/authkit-nextjs", () => ({ getSignInUrl, getSignUpUrl, handleAuth }));
vi.mock("@/lib/auth-identity", () => ({ resolveWorkOSUserId }));

import { GET as signIn } from "@/app/sign-in/route";
import { GET as signUp } from "@/app/sign-up/route";
import { GET as callback } from "@/app/callback/route";

beforeEach(() => {
  getSignInUrl.mockReset();
  getSignUpUrl.mockReset();
  resolveWorkOSUserId.mockReset();
});

describe("hosted authentication routes", () => {
  it.each([
    ["sign-in", signIn, getSignInUrl],
    ["sign-up", signUp, getSignUpUrl],
  ] as const)("starts %s through the SDK with an uncached redirect", async (_, handler, getUrl) => {
    getUrl.mockResolvedValue("https://auth.example.test/authorize?state=sealed");
    const response = await handler();
    expect(getUrl).toHaveBeenCalledExactlyOnceWith({ returnTo: "/dashboard" });
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("https://auth.example.test/authorize?state=sealed");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it("initializes the stable personal owner after the SDK authenticates the callback", async () => {
    // The SDK owns PKCE, state verification, token exchange, and session cookies.
    // This mock captures only the application's post-authentication hooks.
    const options = callback as unknown as {
      returnPathname: string;
      onSuccess: (context: { user: { id: string } }) => Promise<void>;
      onError: () => Promise<Response>;
    };
    expect(handleAuth).toHaveBeenCalledOnce();
    expect(options.returnPathname).toBe("/dashboard");
    const user = { id: "user_workos" };
    await options.onSuccess({ user });
    expect(resolveWorkOSUserId).toHaveBeenCalledExactlyOnceWith(user);
    resolveWorkOSUserId.mockRejectedValue(new Error("database unavailable"));
    await expect(options.onSuccess({ user })).rejects.toThrow("database unavailable");
    const response = await options.onError();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unable to sign in. Please try again." });
  });
});
