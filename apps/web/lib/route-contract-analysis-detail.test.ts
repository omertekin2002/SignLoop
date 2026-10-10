import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getAnalysisForUser, deleteAnalysisForContract } = vi.hoisted(() => ({
  auth: vi.fn(),
  getAnalysisForUser: vi.fn(),
  deleteAnalysisForContract: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  getAnalysisForUser,
  deleteAnalysisForContract,
}));

import { DELETE, GET } from "@/app/api/contracts/[id]/analysis/[analysisId]/route";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const ANALYSIS_ID = "22e3e947-f71f-4ecd-a901-adbf24edbb8a";

const params = (id: string, analysisId: string) => ({
  params: Promise.resolve({ id, analysisId }),
});
const url = (id = CONTRACT_ID, analysisId = ANALYSIS_ID) =>
  `http://localhost/api/contracts/${id}/analysis/${analysisId}`;
const getRequest = (id?: string, analysisId?: string) => new Request(url(id, analysisId));
const deleteRequest = (id?: string, analysisId?: string) =>
  new Request(url(id, analysisId), { method: "DELETE" });

const analysisRecord = () => ({
  id: ANALYSIS_ID,
  contractId: CONTRACT_ID,
  riskBadge: "medium",
  resultJson: { summary: "Auto-renews annually.", riskScore: 42 },
  llmProvider: "primary-openai-compatible",
  llmModel: "selected-model",
  llmPromptTokens: 1200,
  llmCompletionTokens: 340,
  processingTimeMs: 5400,
  createdAt: "2026-10-01T10:04:00.000Z",
});

const invalidIds = [
  ["a malformed contract id", "not-a-uuid", ANALYSIS_ID],
  ["a malformed analysis id", CONTRACT_ID, "not-a-uuid"],
  ["a path traversal contract id", "../../etc/passwd", ANALYSIS_ID],
  ["a uuid with trailing characters", CONTRACT_ID, `${ANALYSIS_ID}-extra`],
  ["an empty contract id", "", ANALYSIS_ID],
  ["an empty analysis id", CONTRACT_ID, ""],
] as const;

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/contracts/[id]/analysis/[analysisId]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(getRequest(), params(CONTRACT_ID, ANALYSIS_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getAnalysisForUser).not.toHaveBeenCalled();
  });

  it("checks authentication before validating the ids", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(
      getRequest("not-a-uuid", "not-a-uuid"),
      params("not-a-uuid", "not-a-uuid"),
    );

    expect(response.status).toBe(401);
    expect(getAnalysisForUser).not.toHaveBeenCalled();
  });

  it.each(invalidIds)(
    "returns 404 for %s without querying the database",
    async (_label, id, analysisId) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await GET(getRequest(), params(id, analysisId));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Analysis not found" });
      expect(getAnalysisForUser).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the analysis is missing or belongs to another user", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getAnalysisForUser.mockResolvedValue(null);

    const response = await GET(getRequest(), params(CONTRACT_ID, ANALYSIS_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Analysis not found" });
    expect(getAnalysisForUser).toHaveBeenCalledExactlyOnceWith(
      "intruder",
      CONTRACT_ID,
      ANALYSIS_ID,
    );
  });

  it("returns the analysis record as-is with 200, scoped to the signed-in owner", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getAnalysisForUser.mockResolvedValue(analysisRecord());

    const response = await GET(getRequest(), params(CONTRACT_ID, ANALYSIS_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(analysisRecord());
    expect(getAnalysisForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      CONTRACT_ID,
      ANALYSIS_ID,
    );
    expect(deleteAnalysisForContract).not.toHaveBeenCalled();
  });

  it("matches uuids case-insensitively and forwards them unchanged", async () => {
    const upperContract = CONTRACT_ID.toUpperCase();
    const upperAnalysis = ANALYSIS_ID.toUpperCase();
    auth.mockResolvedValue({ userId: "owner" });
    getAnalysisForUser.mockResolvedValue(analysisRecord());

    const response = await GET(
      getRequest(upperContract, upperAnalysis),
      params(upperContract, upperAnalysis),
    );

    expect(response.status).toBe(200);
    expect(getAnalysisForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      upperContract,
      upperAnalysis,
    );
  });
});

describe("DELETE /api/contracts/[id]/analysis/[analysisId]", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID, ANALYSIS_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(deleteAnalysisForContract).not.toHaveBeenCalled();
  });

  it("checks authentication before validating the ids", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(
      deleteRequest("not-a-uuid", "not-a-uuid"),
      params("not-a-uuid", "not-a-uuid"),
    );

    expect(response.status).toBe(401);
    expect(deleteAnalysisForContract).not.toHaveBeenCalled();
  });

  it.each(invalidIds)(
    "returns 404 for %s without deleting anything",
    async (_label, id, analysisId) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await DELETE(deleteRequest(), params(id, analysisId));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Analysis not found" });
      expect(deleteAnalysisForContract).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when nothing was deleted (missing analysis or another user's contract)", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    deleteAnalysisForContract.mockResolvedValue(false);

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID, ANALYSIS_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Analysis not found" });
    expect(deleteAnalysisForContract).toHaveBeenCalledExactlyOnceWith({
      userId: "intruder",
      contractId: CONTRACT_ID,
      analysisId: ANALYSIS_ID,
    });
  });

  it("deletes the requested analysis for the signed-in owner and returns 200", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteAnalysisForContract.mockResolvedValue(true);

    const response = await DELETE(deleteRequest(), params(CONTRACT_ID, ANALYSIS_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(deleteAnalysisForContract).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      contractId: CONTRACT_ID,
      analysisId: ANALYSIS_ID,
    });
    expect(getAnalysisForUser).not.toHaveBeenCalled();
  });

  it("never passes keepAnalysisId, so only the named analysis is targeted", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteAnalysisForContract.mockResolvedValue(true);

    await DELETE(deleteRequest(), params(CONTRACT_ID, ANALYSIS_ID));

    const [input] = deleteAnalysisForContract.mock.calls[0] as [Record<string, unknown>];
    expect(input).not.toHaveProperty("keepAnalysisId");
    expect(input.analysisId).toBe(ANALYSIS_ID);
  });
});
