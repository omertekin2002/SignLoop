import { afterEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  after,
  getProjectByIdForUser,
  deleteProjectForUser,
  flushStorageDeletions,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  after: vi.fn(),
  getProjectByIdForUser: vi.fn(),
  deleteProjectForUser: vi.fn(),
  flushStorageDeletions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));
vi.mock("@/lib/server-db", () => ({
  getProjectByIdForUser,
  deleteProjectForUser,
}));
vi.mock("@/lib/storage-cleanup", () => ({ flushStorageDeletions }));

import { DELETE, GET } from "@/app/api/projects/[id]/route";

const PROJECT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const getRequest = (query = "") =>
  new Request(`http://localhost/api/projects/${PROJECT_ID}${query}`);
const deleteRequest = () =>
  new Request(`http://localhost/api/projects/${PROJECT_ID}`, {
    method: "DELETE",
  });

const projectRecord = () => ({
  id: PROJECT_ID,
  userId: "owner",
  title: "Office lease",
  description: "Renewal negotiation",
  status: "active",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:05:00.000Z",
  contracts: [
    {
      id: "22e3e947-f71f-4ecd-a901-adbf24edbb8a",
      title: "Master lease",
      status: "analyzed",
    },
  ],
  contractsHasMore: true,
  context: [],
  contextHasMore: false,
});

const invalidIds = [
  ["a non-uuid string", "not-a-uuid"],
  ["a path traversal attempt", "../../etc/passwd"],
  ["a uuid with trailing characters", `${PROJECT_ID}-extra`],
  ["an empty string", ""],
] as const;

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/projects/[id]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(getRequest(), params(PROJECT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getProjectByIdForUser).not.toHaveBeenCalled();
  });

  it.each(invalidIds)(
    "returns 404 for %s without querying the database",
    async (_label, id) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await GET(getRequest(), params(id));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Project not found" });
      expect(getProjectByIdForUser).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the project is missing or owned by someone else", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getProjectByIdForUser.mockResolvedValue(null);

    const response = await GET(getRequest(), params(PROJECT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(getProjectByIdForUser).toHaveBeenCalledExactlyOnceWith(
      "intruder",
      PROJECT_ID,
      expect.any(Object),
    );
  });

  it("returns the project scoped to the signed-in user with default offsets", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getProjectByIdForUser.mockResolvedValue(projectRecord());

    const response = await GET(getRequest(), params(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(projectRecord());
    expect(getProjectByIdForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      PROJECT_ID,
      { contractsOffset: 0, contextOffset: 0 },
    );
  });

  it("forwards pagination offsets from the query string", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getProjectByIdForUser.mockResolvedValue(projectRecord());

    const response = await GET(
      getRequest("?contractsOffset=25&contextOffset=50"),
      params(PROJECT_ID),
    );

    expect(response.status).toBe(200);
    expect(getProjectByIdForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      PROJECT_ID,
      { contractsOffset: 25, contextOffset: 50 },
    );
  });

  it("lets unexpected database failures propagate instead of masking them as 404", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getProjectByIdForUser.mockRejectedValue(new Error("db down"));

    await expect(GET(getRequest(), params(PROJECT_ID))).rejects.toThrow(
      "db down",
    );
  });
});

describe("DELETE /api/projects/[id]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(deleteRequest(), params(PROJECT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(deleteProjectForUser).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it.each(invalidIds)(
    "returns 404 for %s without deleting anything",
    async (_label, id) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await DELETE(deleteRequest(), params(id));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Project not found" });
      expect(deleteProjectForUser).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
    },
  );

  it("returns 404 and schedules no cleanup when nothing was deleted", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    deleteProjectForUser.mockResolvedValue({ deleted: false });

    const response = await DELETE(deleteRequest(), params(PROJECT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(deleteProjectForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "intruder",
      projectId: PROJECT_ID,
    });
    expect(after).not.toHaveBeenCalled();
    expect(flushStorageDeletions).not.toHaveBeenCalled();
  });

  it("deletes the owned project and schedules a storage flush after the response", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteProjectForUser.mockResolvedValue({ deleted: true });
    flushStorageDeletions.mockResolvedValue({ claimed: 2, completed: 2 });

    const response = await DELETE(deleteRequest(), params(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(deleteProjectForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      projectId: PROJECT_ID,
    });
    expect(after).toHaveBeenCalledOnce();
    expect(flushStorageDeletions).not.toHaveBeenCalled();

    const scheduled = after.mock.lastCall?.[0] as () => Promise<void>;
    await expect(scheduled()).resolves.toBeUndefined();
    expect(flushStorageDeletions).toHaveBeenCalledOnce();
  });

  it("lets unexpected database failures propagate without scheduling cleanup", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteProjectForUser.mockRejectedValue(new Error("db down"));

    await expect(DELETE(deleteRequest(), params(PROJECT_ID))).rejects.toThrow(
      "db down",
    );
    expect(after).not.toHaveBeenCalled();
  });
});
