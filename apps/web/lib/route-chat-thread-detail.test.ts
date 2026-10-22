import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, getChatThreadByIdForUser, deleteChatThreadForUser } = vi.hoisted(() => ({
  auth: vi.fn(),
  getChatThreadByIdForUser: vi.fn(),
  deleteChatThreadForUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  getChatThreadByIdForUser,
  deleteChatThreadForUser,
}));

import { DELETE, GET } from "@/app/api/chat/threads/[id]/route";

const THREAD_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const MAX_CURSOR = 2147483647;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const rejectedParams = () => {
  const rejected = Promise.reject<{ id: string }>(new Error("bad params"));
  rejected.catch(() => {});
  return { params: rejected };
};
const getRequest = (query = "") =>
  new Request(`http://localhost/api/chat/threads/${THREAD_ID}${query}`);
const deleteRequest = () =>
  new Request(`http://localhost/api/chat/threads/${THREAD_ID}`, { method: "DELETE" });

const threadRecord = () => ({
  id: THREAD_ID,
  userId: "owner",
  title: "Lease questions",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:05:00.000Z",
  hasMore: true,
  messages: [
    {
      id: "m-1",
      threadId: THREAD_ID,
      role: "user" as const,
      content: "What does clause 4 mean?",
      position: 1,
      createdAt: "2026-10-01T10:00:00.000Z",
      model: null,
      provider: null,
      toolActivity: undefined,
    },
    {
      id: "m-2",
      threadId: THREAD_ID,
      role: "assistant" as const,
      content: "Clause 4 sets the notice period.",
      position: 2,
      createdAt: "2026-10-01T10:00:05.000Z",
      model: "model-a",
      provider: "provider-a",
      toolActivity: [{ tool: "search_contract", status: "done" }],
      agentMessages: [{ role: "assistant", content: "replay-only state" }],
      webSources: [{ title: "Source", url: "https://example.com" }],
    },
  ],
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/chat/threads/[id]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(getRequest(), params(THREAD_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getChatThreadByIdForUser).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed thread id without querying the database", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await GET(getRequest(), params("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Thread not found" });
    expect(getChatThreadByIdForUser).not.toHaveBeenCalled();
  });

  it("returns 404 when the thread is missing or belongs to another user", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getChatThreadByIdForUser.mockResolvedValue(null);

    const response = await GET(getRequest(), params(THREAD_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Thread not found" });
    expect(getChatThreadByIdForUser).toHaveBeenCalledWith("intruder", THREAD_ID, MAX_CURSOR);
  });

  it("returns the owner's thread with replay-only message fields stripped", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatThreadByIdForUser.mockResolvedValue(threadRecord());

    const response = await GET(getRequest(), params(THREAD_ID));

    expect(response.status).toBe(200);
    expect(getChatThreadByIdForUser).toHaveBeenCalledOnce();
    expect(getChatThreadByIdForUser).toHaveBeenCalledWith("owner", THREAD_ID, MAX_CURSOR);

    const { data } = (await response.json()) as {
      data: { messages: Record<string, unknown>[] } & Record<string, unknown>;
    };
    expect(data).toMatchObject({
      id: THREAD_ID,
      userId: "owner",
      title: "Lease questions",
      hasMore: true,
    });
    expect(data.messages).toHaveLength(2);
    expect(data.messages[1]).toEqual({
      id: "m-2",
      threadId: THREAD_ID,
      role: "assistant",
      content: "Clause 4 sets the notice period.",
      position: 2,
      createdAt: "2026-10-01T10:00:05.000Z",
      model: "model-a",
      provider: "provider-a",
      toolActivity: [{ tool: "search_contract", status: "done" }],
    });
    for (const message of data.messages) {
      expect(message).not.toHaveProperty("agentMessages");
      expect(message).not.toHaveProperty("webSources");
    }
  });

  it("passes a valid history cursor through to the owner-scoped query", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatThreadByIdForUser.mockResolvedValue({ ...threadRecord(), messages: [], hasMore: false });

    const response = await GET(getRequest("?before=42"), params(THREAD_ID));

    expect(response.status).toBe(200);
    expect(getChatThreadByIdForUser).toHaveBeenCalledWith("owner", THREAD_ID, 42);
    expect(await response.json()).toMatchObject({ data: { messages: [], hasMore: false } });
  });

  it("accepts the smallest and largest cursor values", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatThreadByIdForUser.mockResolvedValue({ ...threadRecord(), messages: [] });

    expect((await GET(getRequest("?before=1"), params(THREAD_ID))).status).toBe(200);
    expect((await GET(getRequest(`?before=${MAX_CURSOR}`), params(THREAD_ID))).status).toBe(200);
    expect(getChatThreadByIdForUser).toHaveBeenNthCalledWith(1, "owner", THREAD_ID, 1);
    expect(getChatThreadByIdForUser).toHaveBeenNthCalledWith(2, "owner", THREAD_ID, MAX_CURSOR);
  });

  it.each([
    ["empty", "?before="],
    ["zero", "?before=0"],
    ["negative", "?before=-3"],
    ["fractional", "?before=1.5"],
    ["non-numeric", "?before=abc"],
    ["above the int32 limit", `?before=${MAX_CURSOR + 1}`],
    ["beyond safe integer range", "?before=9007199254740993"],
    ["infinite", "?before=Infinity"],
  ])("returns 400 for a %s history cursor", async (_label, query) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await GET(getRequest(query), params(THREAD_ID));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid history cursor" });
    expect(getChatThreadByIdForUser).not.toHaveBeenCalled();
  });

  it("returns 500 without leaking details when the database lookup fails", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getChatThreadByIdForUser.mockRejectedValue(new Error("connection reset by peer"));

    const response = await GET(getRequest(), params(THREAD_ID));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch chat thread" });
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("returns 500 when the route params fail to resolve", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await GET(getRequest(), rejectedParams());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch chat thread" });
    expect(getChatThreadByIdForUser).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/chat/threads/[id]", () => {
  it("opts abandoned-draft cleanup into empty-only deletion", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteChatThreadForUser.mockResolvedValue(true);
    const response = await DELETE(
      new Request(`http://localhost/api/chat/threads/${THREAD_ID}?onlyIfEmpty=1`, { method: "DELETE" }),
      params(THREAD_ID),
    );
    expect(response.status).toBe(200);
    expect(deleteChatThreadForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner", threadId: THREAD_ID, onlyIfEmpty: true,
    });
  });

  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(deleteRequest(), params(THREAD_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(deleteChatThreadForUser).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed thread id without querying the database", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await DELETE(deleteRequest(), params("../../etc/passwd"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Thread not found" });
    expect(deleteChatThreadForUser).not.toHaveBeenCalled();
  });

  it("returns 404 when nothing was deleted for this owner", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    deleteChatThreadForUser.mockResolvedValue(false);

    const response = await DELETE(deleteRequest(), params(THREAD_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Thread not found" });
    expect(deleteChatThreadForUser).toHaveBeenCalledWith({
      userId: "intruder",
      threadId: THREAD_ID,
    });
  });

  it("deletes the thread for the authenticated owner and reports success", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteChatThreadForUser.mockResolvedValue(true);

    const response = await DELETE(deleteRequest(), params(THREAD_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(deleteChatThreadForUser).toHaveBeenCalledOnce();
    expect(deleteChatThreadForUser).toHaveBeenCalledWith({ userId: "owner", threadId: THREAD_ID });
  });

  it("returns 500 without leaking details when the delete fails", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteChatThreadForUser.mockRejectedValue(new Error("deadlock detected"));

    const response = await DELETE(deleteRequest(), params(THREAD_ID));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to delete chat thread" });
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("returns 500 when the route params fail to resolve", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await DELETE(deleteRequest(), rejectedParams());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to delete chat thread" });
    expect(deleteChatThreadForUser).not.toHaveBeenCalled();
  });
});
