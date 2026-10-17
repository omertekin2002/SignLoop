import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getContractMetaForUser, deleteAnalysisForContract } = vi.hoisted(() => ({
  auth: vi.fn(),
  getContractMetaForUser: vi.fn(),
  deleteAnalysisForContract: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  getContractMetaForUser,
  deleteAnalysisForContract,
}));

import { DELETE } from "@/app/api/contracts/[id]/analysis/route";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const KEEP_ID = "22e3e947-f71f-4ecd-a901-adbf24edbb8a";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const deleteRequest = (query = `?keep=${KEEP_ID}`, id = CONTRACT_ID) =>
  new Request(`http://localhost/api/contracts/${id}/analysis${query}`, { method: "DELETE" });

const contractMeta = () => ({
  id: CONTRACT_ID,
  userId: "owner",
  projectId: null,
  title: "Master services agreement",
  status: "analyzed",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:05:00.000Z",
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("DELETE /api/contracts/[id]/analysis", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getContractMetaForUser).not.toHaveBeenCalled();
    expect(deleteAnalysisForContract).not.toHaveBeenCalled();
  });

  it("checks authentication before validating the selection", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(deleteRequest("", "not-a-uuid"), params("not-a-uuid"));

    expect(response.status).toBe(401);
  });

  it.each([
    ["a malformed contract id", "not-a-uuid", `?keep=${KEEP_ID}`],
    ["a missing keep parameter", CONTRACT_ID, ""],
    ["an empty keep parameter", CONTRACT_ID, "?keep="],
    ["a malformed keep parameter", CONTRACT_ID, "?keep=not-a-uuid"],
    ["a keep parameter with trailing characters", CONTRACT_ID, `?keep=${KEEP_ID}x`],
    ["a SQL-looking keep parameter", CONTRACT_ID, "?keep=1%27%20OR%20%271%27%3D%271"],
  ])("returns 400 for %s", async (_label, id, query) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await DELETE(deleteRequest(query, id), params(id));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid analysis selection" });
    expect(getContractMetaForUser).not.toHaveBeenCalled();
    expect(deleteAnalysisForContract).not.toHaveBeenCalled();
  });

  it("returns 404 without deleting when the contract is not visible to the caller", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getContractMetaForUser.mockResolvedValue(null);

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(getContractMetaForUser).toHaveBeenCalledExactlyOnceWith("intruder", CONTRACT_ID);
    expect(deleteAnalysisForContract).not.toHaveBeenCalled();
  });

  it("deletes the other analyses scoped to the signed-in owner and returns success", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    deleteAnalysisForContract.mockResolvedValue(true);

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(getContractMetaForUser).toHaveBeenCalledExactlyOnceWith("owner", CONTRACT_ID);
    expect(deleteAnalysisForContract).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      contractId: CONTRACT_ID,
      keepAnalysisId: KEEP_ID,
    });
  });

  it("accepts upper-case UUIDs and forwards them unchanged", async () => {
    const contractId = CONTRACT_ID.toUpperCase();
    const keepId = KEEP_ID.toUpperCase();
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    deleteAnalysisForContract.mockResolvedValue(true);

    const response = await DELETE(deleteRequest(`?keep=${keepId}`, contractId), params(contractId));

    expect(response.status).toBe(200);
    expect(deleteAnalysisForContract).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      contractId,
      keepAnalysisId: keepId,
    });
  });

  it("does not report success when the deletion fails", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    deleteAnalysisForContract.mockRejectedValue(new Error("database unavailable"));

    await expect(DELETE(deleteRequest(), params(CONTRACT_ID))).rejects.toThrow(
      "database unavailable",
    );
    expect(deleteAnalysisForContract).toHaveBeenCalledTimes(1);
  });

  it("uses the first keep parameter when several are supplied", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    deleteAnalysisForContract.mockResolvedValue(true);

    const response = await DELETE(
      deleteRequest(`?keep=${KEEP_ID}&keep=33e3e947-f71f-4ecd-a901-adbf24edbb8a`),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(200);
    expect(deleteAnalysisForContract).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      contractId: CONTRACT_ID,
      keepAnalysisId: KEEP_ID,
    });
  });
});
