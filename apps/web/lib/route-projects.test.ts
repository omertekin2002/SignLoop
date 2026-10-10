import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, createProjectForUser, listProjectsByUserId } = vi.hoisted(() => ({
  auth: vi.fn(),
  createProjectForUser: vi.fn(),
  listProjectsByUserId: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  createProjectForUser,
  listProjectsByUserId,
}));

import { GET, POST } from "@/app/api/projects/route";

const projectsUrl = "http://localhost/api/projects";

const projectSummary = {
  id: "5b7d7f63-8f61-4a52-9d6f-3a0c1b2e4d10",
  userId: "owner",
  title: "Q4 Vendor Agreements",
  description: "Renewals for the fourth quarter",
  status: "active",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  contractCount: 0,
  contextDocumentCount: 0,
};

const emptyPage = { data: [], total: 0, limit: 20, offset: 0 };

const postRequest = (body?: string) =>
  new Request(projectsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

const postJson = (body: unknown) => postRequest(JSON.stringify(body));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/projects", () => {
  it("returns 401 without touching the database when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(new Request(projectsUrl));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(listProjectsByUserId).not.toHaveBeenCalled();
  });

  it("lists the owner's projects with default pagination and returns the page as-is", async () => {
    const page = { ...emptyPage, data: [projectSummary], total: 1 };
    auth.mockResolvedValue({ userId: "owner" });
    listProjectsByUserId.mockResolvedValue(page);

    const response = await GET(new Request(projectsUrl));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(listProjectsByUserId).toHaveBeenCalledExactlyOnceWith("owner", {
      limit: undefined,
      offset: undefined,
    });
  });

  it("forwards limit and offset query params as numbers", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listProjectsByUserId.mockResolvedValue({
      ...emptyPage,
      limit: 5,
      offset: 10,
    });

    const response = await GET(new Request(`${projectsUrl}?limit=5&offset=10`));

    expect(response.status).toBe(200);
    expect(listProjectsByUserId).toHaveBeenCalledExactlyOnceWith("owner", {
      limit: 5,
      offset: 10,
    });
  });

  it("scopes the listing to the caller rather than any query-supplied user", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listProjectsByUserId.mockResolvedValue(emptyPage);

    await GET(new Request(`${projectsUrl}?userId=someone-else`));

    expect(listProjectsByUserId).toHaveBeenCalledExactlyOnceWith(
      "owner",
      expect.any(Object),
    );
  });

  it("does not swallow a data-layer failure", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listProjectsByUserId.mockRejectedValue(new Error("connection refused"));

    await expect(GET(new Request(projectsUrl))).rejects.toThrow(
      "connection refused",
    );
  });
});

describe("POST /api/projects", () => {
  it("returns 401 without creating a project when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(postJson({ title: "Vendors" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(createProjectForUser).not.toHaveBeenCalled();
  });

  it("creates a project for the owner and returns it with 201", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createProjectForUser.mockResolvedValue(projectSummary);

    const response = await POST(
      postJson({
        title: "Q4 Vendor Agreements",
        description: "Renewals for the fourth quarter",
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(projectSummary);
    expect(createProjectForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Q4 Vendor Agreements",
      description: "Renewals for the fourth quarter",
    });
  });

  it("creates a project without a description as null", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createProjectForUser.mockResolvedValue({
      ...projectSummary,
      description: null,
    });

    const response = await POST(postJson({ title: "Vendors" }));

    expect(response.status).toBe(201);
    expect(createProjectForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Vendors",
      description: null,
    });
  });

  it("trims surrounding whitespace from the title and description", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createProjectForUser.mockResolvedValue(projectSummary);

    await POST(
      postJson({
        title: "  Master Services Agreement \n",
        description: "\t Renewals  ",
      }),
    );

    expect(createProjectForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Master Services Agreement",
      description: "Renewals",
    });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "  \t\n "],
    ["a number", 42],
    ["null", null],
    ["an object", { text: "x" }],
    ["an array", ["x"]],
  ])(
    "stores a null description when the description is %s",
    async (_label, description) => {
      auth.mockResolvedValue({ userId: "owner" });
      createProjectForUser.mockResolvedValue(projectSummary);

      const response = await POST(postJson({ title: "Vendors", description }));

      expect(response.status).toBe(201);
      expect(createProjectForUser).toHaveBeenCalledExactlyOnceWith({
        userId: "owner",
        title: "Vendors",
        description: null,
      });
    },
  );

  it("does not let the body override the owner or other server-set fields", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createProjectForUser.mockResolvedValue(projectSummary);

    await POST(
      postJson({
        title: "Mine",
        userId: "someone-else",
        status: "archived",
        id: "forced-id",
      }),
    );

    expect(createProjectForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Mine",
      description: null,
    });
  });

  it.each([
    ["an empty body", ""],
    ["malformed JSON", "{not json"],
    ["a JSON null", "null"],
  ])("returns 400 without creating a project for %s", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(createProjectForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["an empty string", { title: "" }],
    ["whitespace only", { title: "   \t\n" }],
    ["a number", { title: 42 }],
    ["null", { title: null }],
    ["an object", { title: { nested: "x" } }],
    ["an array", { title: ["x"] }],
    ["on a JSON array body", []],
    ["on a JSON string body", "Vendors"],
  ])(
    "returns 400 without creating a project when the title is %s",
    async (_label, body) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await POST(postJson(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Project title is required",
      });
      expect(createProjectForUser).not.toHaveBeenCalled();
    },
  );

  it("does not run body validation or creation before authentication", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(postRequest("{not json"));

    expect(response.status).toBe(401);
    expect(createProjectForUser).not.toHaveBeenCalled();
  });

  it("rethrows a database failure instead of mapping it to a client error", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createProjectForUser.mockRejectedValue(new Error("insert failed"));

    await expect(POST(postJson({ title: "Vendors" }))).rejects.toThrow(
      "insert failed",
    );
  });
});
