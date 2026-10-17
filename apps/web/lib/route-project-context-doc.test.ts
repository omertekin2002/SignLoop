import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, after, deleteContextDocumentFromProject, flushStorageDeletions } =
  vi.hoisted(() => ({
    auth: vi.fn(),
    after: vi.fn(),
    deleteContextDocumentFromProject: vi.fn(),
    flushStorageDeletions: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));
vi.mock("@/lib/server-db", () => ({ deleteContextDocumentFromProject }));
vi.mock("@/lib/storage-cleanup", () => ({ flushStorageDeletions }));

import { DELETE } from "@/app/api/projects/[id]/context/[docId]/route";

const PROJECT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const DOC_ID = "22e3e947-f71f-4ecd-a901-adbf24edbb8a";

const params = (id: string, docId: string) => ({
  params: Promise.resolve({ id, docId }),
});
const deleteRequest = (id = PROJECT_ID, docId = DOC_ID) =>
  new Request(`http://localhost/api/projects/${id}/context/${docId}`, {
    method: "DELETE",
  });

afterEach(() => {
  vi.resetAllMocks();
});

describe("DELETE /api/projects/[id]/context/[docId]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(deleteRequest(), params(PROJECT_ID, DOC_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(deleteContextDocumentFromProject).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed project id", "not-a-uuid", DOC_ID],
    ["a malformed document id", PROJECT_ID, "not-a-uuid"],
    ["an empty document id", PROJECT_ID, ""],
    ["a SQL-injection-shaped id", `${PROJECT_ID}' or '1'='1`, DOC_ID],
  ])("returns 404 for %s before reaching the database", async (_label, id, docId) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await DELETE(deleteRequest(), params(id, docId));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Context document not found",
    });
    expect(deleteContextDocumentFromProject).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("returns 404 when the document is missing or owned by another user", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    deleteContextDocumentFromProject.mockResolvedValue({ deleted: false });

    const response = await DELETE(deleteRequest(), params(PROJECT_ID, DOC_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Context document not found",
    });
    expect(deleteContextDocumentFromProject).toHaveBeenCalledExactlyOnceWith({
      userId: "intruder",
      projectId: PROJECT_ID,
      documentId: DOC_ID,
    });
    expect(after).not.toHaveBeenCalled();
    expect(flushStorageDeletions).not.toHaveBeenCalled();
  });

  it("deletes the document with owner-scoped ids and returns 200", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteContextDocumentFromProject.mockResolvedValue({ deleted: true });

    const response = await DELETE(deleteRequest(), params(PROJECT_ID, DOC_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(deleteContextDocumentFromProject).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      projectId: PROJECT_ID,
      documentId: DOC_ID,
    });
  });

  it("accepts upper-case UUIDs", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteContextDocumentFromProject.mockResolvedValue({ deleted: true });

    const response = await DELETE(
      deleteRequest(),
      params(PROJECT_ID.toUpperCase(), DOC_ID.toUpperCase()),
    );

    expect(response.status).toBe(200);
    expect(deleteContextDocumentFromProject).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      projectId: PROJECT_ID.toUpperCase(),
      documentId: DOC_ID.toUpperCase(),
    });
  });

  it("defers the storage-deletion flush until after the response", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteContextDocumentFromProject.mockResolvedValue({ deleted: true });
    flushStorageDeletions.mockResolvedValue({ claimed: 1, completed: 1 });

    await DELETE(deleteRequest(), params(PROJECT_ID, DOC_ID));

    expect(after).toHaveBeenCalledOnce();
    expect(flushStorageDeletions).not.toHaveBeenCalled();

    const task = after.mock.calls[0]?.[0] as () => Promise<void>;
    await expect(task()).resolves.toBeUndefined();
    expect(flushStorageDeletions).toHaveBeenCalledOnce();
  });

  it("lets a delete failure reject without scheduling storage cleanup", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteContextDocumentFromProject.mockRejectedValue(
      new Error("deadlock detected"),
    );

    await expect(
      DELETE(deleteRequest(), params(PROJECT_ID, DOC_ID)),
    ).rejects.toThrow("deadlock detected");
    expect(after).not.toHaveBeenCalled();
    expect(flushStorageDeletions).not.toHaveBeenCalled();
  });
});
