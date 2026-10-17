import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, createContractForUser, listContractsByUserId } = vi.hoisted(
  () => ({
    auth: vi.fn(),
    createContractForUser: vi.fn(),
    listContractsByUserId: vi.fn(),
  }),
);

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  createContractForUser,
  listContractsByUserId,
}));

import { GET, POST } from "@/app/api/contracts/route";
import { ProjectNotFoundError } from "@/lib/errors";

const contractsUrl = "http://localhost/api/contracts";
const projectId = "5b7d7f63-8f61-4a52-9d6f-3a0c1b2e4d10";

const contractSummary = {
  id: "11e3e947-f71f-4ecd-a901-adbf24edbb8a",
  userId: "owner",
  projectId: null,
  title: "Untitled Contract",
  status: "DRAFT",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const emptyPage = { data: [], total: 0, limit: 20, offset: 0 };

const postRequest = (body?: string) =>
  new Request(contractsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

const postJson = (body: unknown) => postRequest(JSON.stringify(body));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/contracts", () => {
  it("returns 401 without touching the database when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(new Request(contractsUrl));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(listContractsByUserId).not.toHaveBeenCalled();
  });

  it("lists contracts for the owner with default pagination and no standalone filter", async () => {
    const page = { ...emptyPage, data: [contractSummary], total: 1 };
    auth.mockResolvedValue({ userId: "owner" });
    listContractsByUserId.mockResolvedValue(page);

    const response = await GET(new Request(contractsUrl));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(listContractsByUserId).toHaveBeenCalledExactlyOnceWith(
      "owner",
      { limit: undefined, offset: undefined },
      false,
    );
  });

  it("forwards limit and offset query params as numbers", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listContractsByUserId.mockResolvedValue({
      ...emptyPage,
      limit: 5,
      offset: 10,
    });

    const response = await GET(
      new Request(`${contractsUrl}?limit=5&offset=10`),
    );

    expect(response.status).toBe(200);
    expect(listContractsByUserId).toHaveBeenCalledExactlyOnceWith(
      "owner",
      { limit: 5, offset: 10 },
      false,
    );
  });

  it("passes standalone=true through as a boolean filter", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listContractsByUserId.mockResolvedValue(emptyPage);

    const response = await GET(new Request(`${contractsUrl}?standalone=true`));

    expect(response.status).toBe(200);
    expect(listContractsByUserId).toHaveBeenCalledExactlyOnceWith(
      "owner",
      { limit: undefined, offset: undefined },
      true,
    );
  });

  it.each(["false", "1", "TRUE", ""])(
    "treats standalone=%j as not standalone",
    async (value) => {
      auth.mockResolvedValue({ userId: "owner" });
      listContractsByUserId.mockResolvedValue(emptyPage);

      await GET(new Request(`${contractsUrl}?standalone=${value}`));

      expect(listContractsByUserId).toHaveBeenCalledExactlyOnceWith(
        "owner",
        expect.any(Object),
        false,
      );
    },
  );

  it("scopes the listing to the caller rather than any query-supplied user", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listContractsByUserId.mockResolvedValue(emptyPage);

    await GET(new Request(`${contractsUrl}?userId=someone-else`));

    expect(listContractsByUserId).toHaveBeenCalledExactlyOnceWith(
      "owner",
      expect.any(Object),
      false,
    );
  });

  it("does not swallow a data-layer failure", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listContractsByUserId.mockRejectedValue(new Error("connection refused"));

    await expect(GET(new Request(contractsUrl))).rejects.toThrow(
      "connection refused",
    );
  });
});

describe("POST /api/contracts", () => {
  it("returns 401 without creating a contract when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(postJson({ title: "Lease" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(createContractForUser).not.toHaveBeenCalled();
  });

  it("creates a standalone contract for the owner and returns it with 201", async () => {
    const created = { ...contractSummary, title: "Lease" };
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockResolvedValue(created);

    const response = await POST(postJson({ title: "Lease" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Lease",
      projectId: null,
    });
  });

  it("creates a contract inside a project and passes the validated project id", async () => {
    const created = { ...contractSummary, projectId };
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockResolvedValue(created);

    const response = await POST(postJson({ title: "Lease", projectId }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Lease",
      projectId,
    });
  });

  it("accepts an upper-case UUID project id unchanged", async () => {
    const upper = projectId.toUpperCase();
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockResolvedValue(contractSummary);

    const response = await POST(postJson({ projectId: upper }));

    expect(response.status).toBe(201);
    expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Untitled Contract",
      projectId: upper,
    });
  });

  it("trims surrounding whitespace from the title", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockResolvedValue(contractSummary);

    await POST(postJson({ title: "  Master Services Agreement \n" }));

    expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Master Services Agreement",
      projectId: null,
    });
  });

  it.each([
    ["missing", {}],
    ["an empty string", { title: "" }],
    ["whitespace only", { title: "   \t\n" }],
    ["a number", { title: 42 }],
    ["null", { title: null }],
    ["an object", { title: { nested: "x" } }],
    ["an array", { title: ["x"] }],
  ])(
    "falls back to the default title when the title is %s",
    async (_label, body) => {
      auth.mockResolvedValue({ userId: "owner" });
      createContractForUser.mockResolvedValue(contractSummary);

      const response = await POST(postJson(body));

      expect(response.status).toBe(201);
      expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
        userId: "owner",
        title: "Untitled Contract",
        projectId: null,
      });
    },
  );

  it("treats an explicit null project id as a standalone contract", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockResolvedValue(contractSummary);

    const response = await POST(postJson({ title: "Lease", projectId: null }));

    expect(response.status).toBe(201);
    expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Lease",
      projectId: null,
    });
  });

  it("does not let the body override the owner", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockResolvedValue(contractSummary);

    await POST(postJson({ title: "Mine", userId: "someone-else" }));

    expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Mine",
      projectId: null,
    });
  });

  it.each([
    ["an empty body", ""],
    ["malformed JSON", "{not json"],
    ["a JSON null", "null"],
  ])("returns 400 without creating a contract for %s", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(createContractForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-UUID string", "not-a-uuid"],
    ["an empty string", ""],
    ["a UUID with trailing text", `${projectId}-extra`],
    ["a number", 42],
    ["a boolean", false],
    ["an object", { id: projectId }],
    ["an array", [projectId]],
  ])(
    "returns 400 without creating a contract when the project id is %s",
    async (_label, badProjectId) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await POST(
        postJson({ title: "Lease", projectId: badProjectId }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid project id" });
      expect(createContractForUser).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the project is not owned by the caller", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockRejectedValue(new ProjectNotFoundError());

    const response = await POST(postJson({ title: "Lease", projectId }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(createContractForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      title: "Lease",
      projectId,
    });
  });

  it("rethrows unexpected failures instead of mapping them to 404", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockRejectedValue(new Error("Project not found"));

    await expect(POST(postJson({ title: "Lease", projectId }))).rejects.toThrow(
      "Project not found",
    );
  });

  it("rethrows a database failure", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    createContractForUser.mockRejectedValue(new Error("insert failed"));

    await expect(POST(postJson({ title: "Lease" }))).rejects.toThrow(
      "insert failed",
    );
  });
});
