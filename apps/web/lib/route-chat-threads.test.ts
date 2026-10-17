import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, createChatThreadForUser, listChatThreadsByUserId } = vi.hoisted(
  () => ({
    auth: vi.fn(),
    createChatThreadForUser: vi.fn(),
    listChatThreadsByUserId: vi.fn(),
  }),
);

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  createChatThreadForUser,
  listChatThreadsByUserId,
}));

import { GET, POST } from "@/app/api/chat/threads/route";

const threadsUrl = "http://localhost/api/chat/threads";

const threadSummary = {
  id: "11e3e947-f71f-4ecd-a901-adbf24edbb8a",
  userId: "owner",
  title: "New chat",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  messageCount: 0,
};

const postRequest = (body?: string) =>
  new Request(threadsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/chat/threads", () => {
  it("returns 401 without touching the database when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(new Request(threadsUrl));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(listChatThreadsByUserId).not.toHaveBeenCalled();
  });

  it("lists threads for the authenticated owner with default pagination", async () => {
    const page = { data: [threadSummary], total: 1, limit: 20, offset: 0 };
    auth.mockResolvedValue({ userId: "owner" });
    listChatThreadsByUserId.mockResolvedValue(page);

    const response = await GET(new Request(threadsUrl));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(listChatThreadsByUserId).toHaveBeenCalledExactlyOnceWith("owner", {
      limit: undefined,
      offset: undefined,
    });
  });

  it("forwards limit and offset query params as numbers", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listChatThreadsByUserId.mockResolvedValue({
      data: [],
      total: 0,
      limit: 5,
      offset: 10,
    });

    const response = await GET(new Request(`${threadsUrl}?limit=5&offset=10`));

    expect(response.status).toBe(200);
    expect(listChatThreadsByUserId).toHaveBeenCalledExactlyOnceWith("owner", {
      limit: 5,
      offset: 10,
    });
  });

  it("leaves non-numeric pagination for the data layer to clamp", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listChatThreadsByUserId.mockResolvedValue({
      data: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    const response = await GET(new Request(`${threadsUrl}?limit=abc&offset=-3`));

    expect(response.status).toBe(200);
    expect(listChatThreadsByUserId).toHaveBeenCalledExactlyOnceWith("owner", {
      limit: Number.NaN,
      offset: -3,
    });
  });

  it("scopes the listing to the caller rather than any query-supplied user", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listChatThreadsByUserId.mockResolvedValue({
      data: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    await GET(new Request(`${threadsUrl}?userId=someone-else`));

    expect(listChatThreadsByUserId).toHaveBeenCalledExactlyOnceWith(
      "owner",
      expect.any(Object),
    );
  });

  it("maps a database failure to a generic 500 without leaking the cause", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listChatThreadsByUserId.mockRejectedValue(new Error("connection refused"));

    const response = await GET(new Request(threadsUrl));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to list chat threads",
    });
    expect(console.error).toHaveBeenCalledOnce();
  });
});

describe("POST /api/chat/threads", () => {
  it("returns 401 without creating a thread when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(postRequest(JSON.stringify({ title: "Hi" })));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(createChatThreadForUser).not.toHaveBeenCalled();
  });

  it("creates a thread for the owner with the supplied title and returns 201", async () => {
    const created = { ...threadSummary, title: "Lease questions" };
    auth.mockResolvedValue({ userId: "owner" });
    createChatThreadForUser.mockResolvedValue(created);

    const response = await POST(
      postRequest(JSON.stringify({ title: "Lease questions" })),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: created });
    expect(createChatThreadForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Lease questions",
    });
  });

  it("creates an untitled thread from an empty JSON object", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createChatThreadForUser.mockResolvedValue(threadSummary);

    const response = await POST(postRequest(JSON.stringify({})));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: threadSummary });
    expect(createChatThreadForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: undefined,
    });
  });

  it.each([
    ["an empty body", ""],
    ["malformed JSON", "{not json"],
    ["a JSON null", "null"],
  ])("falls back to an untitled thread for %s", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });
    createChatThreadForUser.mockResolvedValue(threadSummary);

    const response = await POST(postRequest(body));

    expect(response.status).toBe(201);
    expect(createChatThreadForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: undefined,
    });
  });

  it.each([
    ["a number", 42],
    ["an object", { nested: "x" }],
    ["an array", ["x"]],
    ["null", null],
    ["a boolean", true],
  ])("ignores a non-string title (%s)", async (_label, title) => {
    auth.mockResolvedValue({ userId: "owner" });
    createChatThreadForUser.mockResolvedValue(threadSummary);

    const response = await POST(postRequest(JSON.stringify({ title })));

    expect(response.status).toBe(201);
    expect(createChatThreadForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: undefined,
    });
  });

  it("does not let the body override the owner", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createChatThreadForUser.mockResolvedValue(threadSummary);

    await POST(
      postRequest(JSON.stringify({ title: "Mine", userId: "someone-else" })),
    );

    expect(createChatThreadForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Mine",
    });
  });

  it("maps a database failure to a generic 500 without leaking the cause", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createChatThreadForUser.mockRejectedValue(new Error("insert failed"));

    const response = await POST(postRequest(JSON.stringify({})));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to create chat thread",
    });
    expect(console.error).toHaveBeenCalledOnce();
  });
});
