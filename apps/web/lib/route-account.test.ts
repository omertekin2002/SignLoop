import { afterEach, describe, expect, it, vi } from "vitest";

const {
  authWithWorkOSUser,
  after,
  deleteAccountForUser,
  deleteUser,
  flushStorageDeletions,
  calls,
} = vi.hoisted(() => ({
  authWithWorkOSUser: vi.fn(),
  after: vi.fn(),
  deleteAccountForUser: vi.fn(),
  deleteUser: vi.fn(),
  flushStorageDeletions: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/auth", () => ({ authWithWorkOSUser }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));
vi.mock("@workos-inc/authkit-nextjs", () => ({
  getWorkOS: () => ({ userManagement: { deleteUser } }),
}));
vi.mock("@/lib/server-db", () => ({ deleteAccountForUser }));
vi.mock("@/lib/storage-cleanup", () => ({ flushStorageDeletions }));

import { DELETE } from "@/app/api/account/route";

const identity = { userId: "owner", workosUserId: "user_workos" };

const deleteRequest = (body?: unknown) =>
  new Request("http://localhost/api/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const confirmed = () => deleteRequest({ confirm: "DELETE" });

function signedIn() {
  authWithWorkOSUser.mockResolvedValue(identity);
  deleteAccountForUser.mockImplementation(async (_userId: string, options?: { keepLogin?: boolean }) => {
    calls.push(options?.keepLogin ? "data" : "login");
  });
  deleteUser.mockImplementation(async () => {
    calls.push("workos");
  });
}

function sessionCookie(response: Response) {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith("wos-session="));
}

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  calls.length = 0;
});

describe("DELETE /api/account", () => {
  it("returns JSON 401 without a session and deletes nothing", async () => {
    authWithWorkOSUser.mockResolvedValue(null);

    const response = await DELETE(confirmed());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(deleteAccountForUser).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["malformed JSON", "{"],
    ["no confirmation", {}],
    ["the wrong word", { confirm: "delete" }],
    ["a non-string", { confirm: true }],
  ])("returns 400 and deletes nothing with %s", async (_label, body) => {
    signedIn();
    const request =
      typeof body === "string"
        ? new Request("http://localhost/api/account", { method: "DELETE", body })
        : deleteRequest(body);

    const response = await DELETE(request);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('"confirm":"DELETE"');
    expect(deleteAccountForUser).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(sessionCookie(response)).toBeUndefined();
  });

  it("deletes the data, then the WorkOS user, then the owner mapping, then ends the session", async () => {
    signedIn();

    const response = await DELETE(confirmed());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(calls).toEqual(["data", "workos", "login"]);
    expect(deleteAccountForUser.mock.calls).toEqual([["owner", { keepLogin: true }], ["owner"]]);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith("user_workos");
    const cookie = sessionCookie(response);
    expect(cookie).toMatch(/^wos-session=;/);
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);

    // Queued objects are flushed after the response, as other delete routes do.
    expect(after).toHaveBeenCalledOnce();
    flushStorageDeletions.mockResolvedValue({ claimed: 0, completed: 0 });
    await after.mock.calls[0]![0]();
    expect(flushStorageDeletions).toHaveBeenCalledOnce();
  });

  it("expires a configured AuthKit cookie name and domain", async () => {
    signedIn();
    vi.stubEnv("WORKOS_COOKIE_NAME", "custom-session");
    vi.stubEnv("WORKOS_COOKIE_DOMAIN", "example.com");

    const response = await DELETE(confirmed());

    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("custom-session="));
    expect(cookie).toContain("Domain=example.com");
    expect(sessionCookie(response)).toBeUndefined();
  });

  it("never calls WorkOS when the database deletion fails", async () => {
    signedIn();
    deleteAccountForUser.mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(confirmed());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to delete account" });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(sessionCookie(response)).toBeUndefined();
  });

  it("keeps the committed data deletion, the owner mapping and the session when WorkOS fails, and a retry succeeds", async () => {
    signedIn();
    deleteUser.mockRejectedValueOnce(Object.assign(new Error("Server error"), { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const failed = await DELETE(confirmed());

    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toMatch(/data was deleted/);
    expect(calls).toEqual(["data"]);
    expect(sessionCookie(failed)).toBeUndefined();

    // The mapping survived, so the retry sweeps the same owner before trying WorkOS again.
    const retried = await DELETE(confirmed());

    expect(retried.status).toBe(200);
    expect(calls).toEqual(["data", "data", "workos", "login"]);
    expect(deleteAccountForUser.mock.calls.every(([userId]) => userId === "owner")).toBe(true);
    expect(deleteUser).toHaveBeenLastCalledWith("user_workos");
    expect(sessionCookie(retried)).toMatch(/^wos-session=;/);
  });

  it("returns an error and keeps the session when the final mapping deletion fails", async () => {
    signedIn();
    deleteAccountForUser.mockImplementation(async (_userId: string, options?: { keepLogin?: boolean }) => {
      if (!options?.keepLogin) throw new Error("database unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(confirmed());

    expect(response.status).toBe(500);
    expect(deleteUser).toHaveBeenCalledOnce();
    expect(sessionCookie(response)).toBeUndefined();
  });

  it("treats a WorkOS user that no longer exists as deleted", async () => {
    signedIn();
    deleteUser.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404, name: "NotFoundException" }),
    );

    const response = await DELETE(confirmed());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(sessionCookie(response)).toMatch(/^wos-session=;/);
  });
});
