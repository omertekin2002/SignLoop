import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getChatImageForUser } = vi.hoisted(() => ({
  auth: vi.fn(),
  getChatImageForUser: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({ getChatImageForUser }));

import { GET } from "@/app/api/chat/threads/[id]/images/[imageId]/route";

const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const imageId = "7b0d5c1e-2a43-4f6b-9a1c-3d8e5f6a7b8c";

const imageUrl = `http://localhost/api/chat/threads/${threadId}/images/${imageId}`;

const callGet = (id: unknown = threadId, image: unknown = imageId) =>
  GET(new Request(imageUrl), {
    params: Promise.resolve({ id, imageId: image }) as Promise<{
      id: string;
      imageId: string;
    }>,
  });

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/chat/threads/[id]/images/[imageId]", () => {
  it("returns 401 without touching the database when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await callGet();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getChatImageForUser).not.toHaveBeenCalled();
  });

  it("returns the stored image bytes with private, non-sniffable PNG headers", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatImageForUser.mockResolvedValue(pngBytes);

    const response = await callGet();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pngBytes);
  });

  it("scopes the lookup to the authenticated owner and the requested thread and image", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatImageForUser.mockResolvedValue(pngBytes);

    await callGet();

    expect(getChatImageForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      threadId,
      imageId,
    );
  });

  it("accepts upper-case UUIDs", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatImageForUser.mockResolvedValue(pngBytes);

    const response = await callGet(threadId.toUpperCase(), imageId.toUpperCase());

    expect(response.status).toBe(200);
    expect(getChatImageForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      threadId.toUpperCase(),
      imageId.toUpperCase(),
    );
  });

  it("returns an empty 404 when the image is missing or owned by someone else", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getChatImageForUser.mockResolvedValue(null);

    const response = await callGet();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Type")).not.toBe("image/png");
    expect(getChatImageForUser).toHaveBeenCalledExactlyOnceWith(
      "intruder",
      threadId,
      imageId,
    );
  });

  it.each([
    ["a non-UUID thread id", "not-a-uuid", imageId],
    ["a non-UUID image id", threadId, "not-a-uuid"],
    ["an empty thread id", "", imageId],
    ["an empty image id", threadId, ""],
    ["a SQL-injection-shaped thread id", "1' OR '1'='1", imageId],
    ["a UUID with trailing characters", `${threadId}x`, imageId],
    ["a path-traversal image id", threadId, "../../etc/passwd"],
    ["a numeric thread id", 42, imageId],
  ])("returns an empty 404 for %s without querying the database", async (_label, id, image) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await callGet(id, image);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(getChatImageForUser).not.toHaveBeenCalled();
  });

  it("authenticates before validating ids so anonymous callers get 401, not 404", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await callGet("not-a-uuid", "not-a-uuid");

    expect(response.status).toBe(401);
    expect(getChatImageForUser).not.toHaveBeenCalled();
  });

  it("lets a database failure propagate instead of serving a partial response", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatImageForUser.mockRejectedValue(new Error("connection refused"));

    await expect(callGet()).rejects.toThrow("connection refused");
  });
});
