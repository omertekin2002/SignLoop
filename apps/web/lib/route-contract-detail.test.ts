import { afterEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  after,
  getContractByIdForUser,
  deleteContractForUser,
  setContractJurisdictionForUser,
  flushStorageDeletions,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  after: vi.fn(),
  getContractByIdForUser: vi.fn(),
  deleteContractForUser: vi.fn(),
  setContractJurisdictionForUser: vi.fn(),
  flushStorageDeletions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));
vi.mock("@/lib/server-db", () => ({
  getContractByIdForUser,
  deleteContractForUser,
  setContractJurisdictionForUser,
}));
vi.mock("@/lib/storage-cleanup", () => ({ flushStorageDeletions }));

import { DELETE, GET, PATCH } from "@/app/api/contracts/[id]/route";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const getRequest = (query = "") =>
  new Request(`http://localhost/api/contracts/${CONTRACT_ID}${query}`);
const deleteRequest = () =>
  new Request(`http://localhost/api/contracts/${CONTRACT_ID}`, {
    method: "DELETE",
  });

const contractRecord = () => ({
  id: CONTRACT_ID,
  userId: "owner",
  projectId: null,
  title: "Master services agreement",
  status: "analyzed",
  extractionWarning: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:05:00.000Z",
  analyses: [
    {
      id: "22e3e947-f71f-4ecd-a901-adbf24edbb8a",
      contractId: CONTRACT_ID,
      riskScore: 42,
      createdAt: "2026-10-01T10:04:00.000Z",
    },
  ],
  analysesHasMore: true,
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/contracts/[id]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(getRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getContractByIdForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-uuid string", "not-a-uuid"],
    ["a path traversal attempt", "../../etc/passwd"],
    ["a uuid with trailing characters", `${CONTRACT_ID}-extra`],
    ["an empty string", ""],
  ])("returns 404 for %s without querying the database", async (_label, id) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await GET(getRequest(), params(id));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(getContractByIdForUser).not.toHaveBeenCalled();
  });

  it("returns 404 when the contract is missing or belongs to another user", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getContractByIdForUser.mockResolvedValue(null);

    const response = await GET(getRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(getContractByIdForUser).toHaveBeenCalledWith(
      "intruder",
      CONTRACT_ID,
      0,
    );
  });

  it("returns the owner's contract record unchanged", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractByIdForUser.mockResolvedValue(contractRecord());

    const response = await GET(getRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(contractRecord());
    expect(getContractByIdForUser).toHaveBeenCalledOnce();
    expect(getContractByIdForUser).toHaveBeenCalledWith(
      "owner",
      CONTRACT_ID,
      0,
    );
    expect(after).not.toHaveBeenCalled();
  });

  it("includes the current extraction warning so the page can show it before analysis", async () => {
    const warning =
      "Pages 7–9 have little or no selectable text and were not read; they may be scanned images. Verify those pages in the original before relying on the analysis.";
    auth.mockResolvedValue({ userId: "owner" });
    getContractByIdForUser.mockResolvedValue({
      ...contractRecord(),
      status: "DRAFT",
      analyses: [],
      analysesHasMore: false,
      extractionWarning: warning,
    });

    const response = await GET(getRequest(), params(CONTRACT_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ extractionWarning: warning, analyses: [] });
    // Contract text is only served by the paged, owner-scoped source route.
    for (const key of ["text", "textContent", "text_content"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("accepts an upper-case contract uuid", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractByIdForUser.mockResolvedValue(contractRecord());
    const upperId = CONTRACT_ID.toUpperCase();

    const response = await GET(getRequest(), params(upperId));

    expect(response.status).toBe(200);
    expect(getContractByIdForUser).toHaveBeenCalledWith("owner", upperId, 0);
  });

  it("passes the analysisOffset query parameter to the owner-scoped query", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractByIdForUser.mockResolvedValue({
      ...contractRecord(),
      analyses: [],
      analysesHasMore: false,
    });

    const response = await GET(
      getRequest("?analysisOffset=50"),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(200);
    expect(getContractByIdForUser).toHaveBeenCalledWith(
      "owner",
      CONTRACT_ID,
      50,
    );
    expect(await response.json()).toMatchObject({
      analyses: [],
      analysesHasMore: false,
    });
  });

  it("forwards a non-numeric analysisOffset as NaN for the data layer to clamp", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractByIdForUser.mockResolvedValue(contractRecord());

    const response = await GET(
      getRequest("?analysisOffset=abc"),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(200);
    expect(getContractByIdForUser).toHaveBeenCalledOnce();
    const [userId, contractId, offset] = getContractByIdForUser.mock.calls[0]!;
    expect([userId, contractId]).toEqual(["owner", CONTRACT_ID]);
    expect(offset).toBeNaN();
  });

  it("lets a database failure reject instead of mapping it to a response", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractByIdForUser.mockRejectedValue(
      new Error("connection reset by peer"),
    );

    await expect(GET(getRequest(), params(CONTRACT_ID))).rejects.toThrow(
      "connection reset by peer",
    );
  });
});

describe("DELETE /api/contracts/[id]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(deleteContractForUser).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-uuid string", "not-a-uuid"],
    ["a path traversal attempt", "../../etc/passwd"],
    ["an empty string", ""],
  ])("returns 404 for %s without querying the database", async (_label, id) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await DELETE(deleteRequest(), params(id));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(deleteContractForUser).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("returns 404 and schedules no cleanup when nothing was deleted for this owner", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    deleteContractForUser.mockResolvedValue({ deleted: false });

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(deleteContractForUser).toHaveBeenCalledWith({
      userId: "intruder",
      contractId: CONTRACT_ID,
    });
    expect(after).not.toHaveBeenCalled();
    expect(flushStorageDeletions).not.toHaveBeenCalled();
  });

  it("deletes the contract for the authenticated owner and reports success", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteContractForUser.mockResolvedValue({ deleted: true });

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(deleteContractForUser).toHaveBeenCalledOnce();
    expect(deleteContractForUser).toHaveBeenCalledWith({
      userId: "owner",
      contractId: CONTRACT_ID,
    });
  });

  it("defers the storage-deletion flush until after the response", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteContractForUser.mockResolvedValue({ deleted: true });
    flushStorageDeletions.mockResolvedValue({ claimed: 2, completed: 2 });

    await DELETE(deleteRequest(), params(CONTRACT_ID));

    expect(after).toHaveBeenCalledOnce();
    expect(flushStorageDeletions).not.toHaveBeenCalled();

    const task = after.mock.calls[0]?.[0] as () => Promise<void>;
    await expect(task()).resolves.toBeUndefined();
    expect(flushStorageDeletions).toHaveBeenCalledOnce();
  });

  it("lets a delete failure reject without scheduling storage cleanup", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteContractForUser.mockRejectedValue(new Error("deadlock detected"));

    await expect(DELETE(deleteRequest(), params(CONTRACT_ID))).rejects.toThrow(
      "deadlock detected",
    );
    expect(after).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/contracts/[id]", () => {
  const patchRequest = (body: unknown) =>
    new Request(`http://localhost/api/contracts/${CONTRACT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const confirmedAt = "2026-10-26T15:00:00.000Z";

  it("returns JSON 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await PATCH(
      patchRequest({ jurisdiction: "Ontario" }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(setContractJurisdictionForUser).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed id without querying the database", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PATCH(
      patchRequest({ jurisdiction: "Ontario" }),
      params("not-a-uuid"),
    );

    expect(response.status).toBe(404);
    expect(setContractJurisdictionForUser).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's contract", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    setContractJurisdictionForUser.mockResolvedValue(null);

    const response = await PATCH(
      patchRequest({ jurisdiction: "Ontario" }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(setContractJurisdictionForUser).toHaveBeenCalledWith({
      userId: "intruder",
      contractId: CONTRACT_ID,
      jurisdiction: "Ontario",
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a missing field", {}],
    ["an extra field", { jurisdiction: "Ontario", region: "Ontario" }],
    ["a number", { jurisdiction: 7 }],
    ["a blank string", { jurisdiction: "  \n " }],
    ["a placeholder", { jurisdiction: "Unknown" }],
    ["a value over 100 characters", { jurisdiction: "x".repeat(101) }],
    ["an array body", [{ jurisdiction: "Ontario" }]],
  ])("returns 400 for %s without writing", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PATCH(patchRequest(body), params(CONTRACT_ID));

    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(setContractJurisdictionForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["confirms the proposal", "State of Oregon", "State of Oregon"],
    ["changes it to a normalized value", "  Ontario,\n  Canada ", "Ontario, Canada"],
  ])("%s for the owner", async (_label, sent, stored) => {
    auth.mockResolvedValue({ userId: "owner" });
    setContractJurisdictionForUser.mockResolvedValue({
      confirmedJurisdiction: stored,
      jurisdictionConfirmedAt: confirmedAt,
    });

    const response = await PATCH(
      patchRequest({ jurisdiction: sent }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      confirmedJurisdiction: stored,
      jurisdictionConfirmedAt: confirmedAt,
    });
    expect(setContractJurisdictionForUser).toHaveBeenCalledWith({
      userId: "owner",
      contractId: CONTRACT_ID,
      jurisdiction: stored,
    });
  });

  it("clears the jurisdiction with null", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    setContractJurisdictionForUser.mockResolvedValue({
      confirmedJurisdiction: null,
      jurisdictionConfirmedAt: null,
    });

    const response = await PATCH(
      patchRequest({ jurisdiction: null }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      confirmedJurisdiction: null,
      jurisdictionConfirmedAt: null,
    });
    expect(setContractJurisdictionForUser).toHaveBeenCalledWith({
      userId: "owner",
      contractId: CONTRACT_ID,
      jurisdiction: null,
    });
  });
});
