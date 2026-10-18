import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  admitAnalysis,
  analyzeText,
  claimGenerationOperation,
  createAnalysisForContract,
  getContractAnalysisGateForUser,
  getContractWithLatestAnalysisForUser,
  getProjectContextForAnalysis,
  getUserSettingsByUserId,
  getModelAvailabilitySnapshot,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  admitAnalysis: vi.fn(),
  analyzeText: vi.fn(),
  claimGenerationOperation: vi.fn(),
  createAnalysisForContract: vi.fn(),
  getContractAnalysisGateForUser: vi.fn(),
  getContractWithLatestAnalysisForUser: vi.fn(),
  getProjectContextForAnalysis: vi.fn(),
  getUserSettingsByUserId: vi.fn(),
  getModelAvailabilitySnapshot: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/chat-admission", () => ({ admitAnalysis }));
vi.mock("@/lib/analysis", () => ({ analyzeText }));
vi.mock("@/lib/server-db", () => ({
  claimGenerationOperation,
  createAnalysisForContract,
  getContractAnalysisGateForUser,
  getContractWithLatestAnalysisForUser,
  getProjectContextForAnalysis,
  getUserSettingsByUserId,
}));
vi.mock("@/lib/model-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-settings")>()),
  getModelAvailabilitySnapshot,
}));

import { POST, maxDuration } from "@/app/api/contracts/[id]/analyze/route";
import { ContractRevisionChangedError } from "@/lib/errors";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const ANALYSIS_ID = "22e3e947-f71f-4ecd-a901-adbf24edbb8a";
const NEW_ANALYSIS_ID = "33e3e947-f71f-4ecd-a901-adbf24edbb8a";
const PROJECT_ID = "44e3e947-f71f-4ecd-a901-adbf24edbb8a";
const REVISION = "2026-10-01T10:00:00.123456";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const postRequest = (query = "", init: RequestInit = {}) =>
  new Request(`http://localhost/api/contracts/${CONTRACT_ID}/analyze${query}`, {
    method: "POST",
    ...init,
  });

const contractRecord = (overrides: Record<string, unknown> = {}) => ({
  id: CONTRACT_ID,
  userId: "owner",
  projectId: null,
  title: "Master services agreement",
  status: "DRAFT",
  text: "This agreement is made between the parties.",
  extractionWarning: null,
  revision: REVISION,
  latestAnalysis: null,
  ...overrides,
});

const analysisOutput = (overrides: Record<string, unknown> = {}) => ({
  result: { risk_badge: "HIGH", summary: "Risky clauses found" },
  provider: "primary",
  model: "gpt-5",
  promptTokens: 1200,
  completionTokens: 340,
  ...overrides,
});

const release = vi.fn();
const releaseAdmission = vi.fn();

function arrangeRunnableContract(
  contract: Record<string, unknown> = contractRecord(),
) {
  getContractAnalysisGateForUser.mockResolvedValue({
    status: "DRAFT",
    hasText: true,
    latestAnalysisId: null,
  });
  claimGenerationOperation.mockResolvedValue(release);
  getContractWithLatestAnalysisForUser.mockResolvedValue(contract);
  getUserSettingsByUserId.mockResolvedValue(null);
  getModelAvailabilitySnapshot.mockResolvedValue({
    availablePrimaryModels: ["gpt-5", "gpt-5-mini"],
    imageGenerationAvailable: false,
  });
  analyzeText.mockResolvedValue(analysisOutput());
  createAnalysisForContract.mockResolvedValue({ id: NEW_ANALYSIS_ID });
}

beforeEach(() => {
  release.mockResolvedValue(undefined);
  releaseAdmission.mockResolvedValue(undefined);
  admitAnalysis.mockResolvedValue({ release: releaseAdmission });
  auth.mockResolvedValue({ userId: "owner" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/contracts/[id]/analyze", () => {
  it("reserves part of the route budget for persistence", () => {
    expect(maxDuration).toBe(300);
  });

  it("uses the stable owner for shared admission and releases it on success", async () => {
    arrangeRunnableContract();
    expect((await POST(postRequest(), params(CONTRACT_ID))).status).toBe(200);
    expect(admitAnalysis).toHaveBeenCalledWith("owner");
    expect(releaseAdmission).toHaveBeenCalledOnce();
  });
  it("bounds forced analyses and does not call a provider when the shared quota is full", async () => {
    arrangeRunnableContract();
    admitAnalysis.mockResolvedValue({ retryAfter: 3600 });
    const response = await POST(postRequest("?force=true"), params(CONTRACT_ID));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(analyzeText).not.toHaveBeenCalled();
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it("fails closed when admission storage is unavailable", async () => {
    arrangeRunnableContract();
    admitAnalysis.mockRejectedValue(new Error("database unavailable"));
    expect((await POST(postRequest(), params(CONTRACT_ID))).status).toBe(503);
    expect(analyzeText).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it("releases admission after an inference failure", async () => {
    arrangeRunnableContract();
    analyzeText.mockRejectedValue(new Error("provider failed"));
    expect((await POST(postRequest(), params(CONTRACT_ID))).status).toBe(500);
    expect(releaseAdmission).toHaveBeenCalledOnce();
  });
  it("does not charge quota for cached analysis", async () => {
    getContractAnalysisGateForUser.mockResolvedValue({ status: "ANALYZED", hasText: true, latestAnalysisId: ANALYSIS_ID });
    expect((await POST(postRequest(), params(CONTRACT_ID))).status).toBe(200);
    expect(admitAnalysis).not.toHaveBeenCalled();
  });

  describe("authentication and input validation", () => {
    it("returns 401 without touching the database or model when signed out", async () => {
      auth.mockResolvedValue({ userId: null });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
      expect(getContractAnalysisGateForUser).not.toHaveBeenCalled();
      expect(claimGenerationOperation).not.toHaveBeenCalled();
      expect(analyzeText).not.toHaveBeenCalled();
    });

    it.each([
      ["a non-uuid string", "not-a-uuid"],
      ["a path traversal attempt", "../../etc/passwd"],
      ["a uuid with trailing characters", `${CONTRACT_ID}-extra`],
      ["an empty string", ""],
    ])("returns 404 for %s without any lookup or lease", async (_label, id) => {
      const response = await POST(postRequest(), params(id));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Contract not found" });
      expect(getContractAnalysisGateForUser).not.toHaveBeenCalled();
      expect(claimGenerationOperation).not.toHaveBeenCalled();
      expect(getContractWithLatestAnalysisForUser).not.toHaveBeenCalled();
      expect(analyzeText).not.toHaveBeenCalled();
    });

    it("also rejects an invalid id when force is requested", async () => {
      const response = await POST(postRequest("?force=true"), params("nope"));

      expect(response.status).toBe(404);
      expect(claimGenerationOperation).not.toHaveBeenCalled();
    });

    it("accepts an upper-case contract uuid", async () => {
      arrangeRunnableContract();
      const upperId = CONTRACT_ID.toUpperCase();

      const response = await POST(postRequest(), params(upperId));

      expect(response.status).toBe(200);
      expect(getContractAnalysisGateForUser).toHaveBeenCalledWith("owner", upperId);
    });
  });

  describe("pre-lease gate", () => {
    it("returns 404 and takes no lease when the contract is missing or not owned", async () => {
      auth.mockResolvedValue({ userId: "intruder" });
      getContractAnalysisGateForUser.mockResolvedValue(null);

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Contract not found" });
      expect(getContractAnalysisGateForUser).toHaveBeenCalledWith("intruder", CONTRACT_ID);
      expect(claimGenerationOperation).not.toHaveBeenCalled();
      expect(analyzeText).not.toHaveBeenCalled();
    });

    it("returns 400 and takes no lease when the contract has no text", async () => {
      getContractAnalysisGateForUser.mockResolvedValue({
        status: "DRAFT",
        hasText: false,
        latestAnalysisId: null,
      });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Contract has no text content. Upload a file first.",
      });
      expect(claimGenerationOperation).not.toHaveBeenCalled();
      expect(analyzeText).not.toHaveBeenCalled();
    });

    it("returns 400 for a contract with no text even if it was analyzed before", async () => {
      getContractAnalysisGateForUser.mockResolvedValue({
        status: "ANALYZED",
        hasText: false,
        latestAnalysisId: ANALYSIS_ID,
      });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(400);
      expect(claimGenerationOperation).not.toHaveBeenCalled();
    });

    it("reuses the current analysis without a lease, contract read or model call", async () => {
      getContractAnalysisGateForUser.mockResolvedValue({
        status: "ANALYZED",
        hasText: true,
        latestAnalysisId: ANALYSIS_ID,
      });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        message: "Analysis already exists",
        jobId: "done",
        analysisId: ANALYSIS_ID,
      });
      expect(getContractAnalysisGateForUser).toHaveBeenCalledWith("owner", CONTRACT_ID);
      expect(claimGenerationOperation).not.toHaveBeenCalled();
      expect(getContractWithLatestAnalysisForUser).not.toHaveBeenCalled();
      expect(analyzeText).not.toHaveBeenCalled();
      expect(createAnalysisForContract).not.toHaveBeenCalled();
    });

    it("analyzes again when a re-upload marked the contract DRAFT despite a historical analysis", async () => {
      arrangeRunnableContract();
      getContractAnalysisGateForUser.mockResolvedValue({
        status: "DRAFT",
        hasText: true,
        latestAnalysisId: ANALYSIS_ID,
      });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        message: "Analysis complete",
        analysisId: NEW_ANALYSIS_ID,
      });
      expect(analyzeText).toHaveBeenCalledOnce();
    });

    it("analyzes when the contract is ANALYZED but has no latest analysis id", async () => {
      arrangeRunnableContract();
      getContractAnalysisGateForUser.mockResolvedValue({
        status: "ANALYZED",
        hasText: true,
        latestAnalysisId: null,
      });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(analyzeText).toHaveBeenCalledOnce();
    });

    it("skips the gate entirely when force=true and re-analyzes an ANALYZED contract", async () => {
      arrangeRunnableContract(
        contractRecord({ status: "ANALYZED", latestAnalysis: { id: ANALYSIS_ID } }),
      );

      const response = await POST(postRequest("?force=true"), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        message: "Analysis complete",
        jobId: "done",
        analysisId: NEW_ANALYSIS_ID,
      });
      expect(getContractAnalysisGateForUser).not.toHaveBeenCalled();
      expect(analyzeText).toHaveBeenCalledOnce();
      expect(createAnalysisForContract).toHaveBeenCalledOnce();
    });

    it.each(["?force=1", "?force=TRUE", "?force=false", "?force="])(
      "does not treat %s as force and still consults the gate",
      async (query) => {
        getContractAnalysisGateForUser.mockResolvedValue({
          status: "ANALYZED",
          hasText: true,
          latestAnalysisId: ANALYSIS_ID,
        });

        const response = await POST(postRequest(query), params(CONTRACT_ID));

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          message: "Analysis already exists",
        });
        expect(getContractAnalysisGateForUser).toHaveBeenCalledOnce();
        expect(claimGenerationOperation).not.toHaveBeenCalled();
      },
    );

    it("returns 404 with force=true only after the owner-scoped read finds nothing", async () => {
      auth.mockResolvedValue({ userId: "intruder" });
      claimGenerationOperation.mockResolvedValue(release);
      getContractWithLatestAnalysisForUser.mockResolvedValue(null);

      const response = await POST(postRequest("?force=true"), params(CONTRACT_ID));

      expect(response.status).toBe(404);
      expect(getContractWithLatestAnalysisForUser).toHaveBeenCalledWith(
        "intruder",
        CONTRACT_ID,
      );
      expect(release).toHaveBeenCalledOnce();
    });
  });

  describe("generation lease", () => {
    it("returns 409 when another analysis already holds the lease", async () => {
      getContractAnalysisGateForUser.mockResolvedValue({
        status: "DRAFT",
        hasText: true,
        latestAnalysisId: null,
      });
      claimGenerationOperation.mockResolvedValue(null);

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Analysis is already running for this contract.",
      });
      expect(getContractWithLatestAnalysisForUser).not.toHaveBeenCalled();
      expect(analyzeText).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    it("claims an owner-scoped contract lease for 360 seconds", async () => {
      arrangeRunnableContract();

      await POST(postRequest(), params(CONTRACT_ID));

      expect(claimGenerationOperation).toHaveBeenCalledOnce();
      expect(claimGenerationOperation).toHaveBeenCalledWith(
        "owner",
        "contract",
        CONTRACT_ID,
        360,
      );
    });

    it("lets a lease claim failure reject without calling the model", async () => {
      getContractAnalysisGateForUser.mockResolvedValue({
        status: "DRAFT",
        hasText: true,
        latestAnalysisId: null,
      });
      claimGenerationOperation.mockRejectedValue(new Error("connection reset"));

      await expect(POST(postRequest(), params(CONTRACT_ID))).rejects.toThrow(
        "connection reset",
      );
      expect(analyzeText).not.toHaveBeenCalled();
    });

    it("lets a gate failure reject before any lease is taken", async () => {
      getContractAnalysisGateForUser.mockRejectedValue(new Error("deadlock detected"));

      await expect(POST(postRequest(), params(CONTRACT_ID))).rejects.toThrow(
        "deadlock detected",
      );
      expect(claimGenerationOperation).not.toHaveBeenCalled();
    });
  });

  describe("contract read under the lease", () => {
    it("returns 404 and releases the lease when the contract vanished after the gate", async () => {
      arrangeRunnableContract();
      getContractWithLatestAnalysisForUser.mockResolvedValue(null);

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Contract not found" });
      expect(getContractWithLatestAnalysisForUser).toHaveBeenCalledWith(
        "owner",
        CONTRACT_ID,
      );
      expect(analyzeText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it.each([
      ["null text", null],
      ["empty text", ""],
      ["whitespace-only text", "  \n\t  "],
    ])("returns 400 and releases the lease for %s", async (_label, text) => {
      arrangeRunnableContract(contractRecord({ text }));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Contract has no text content. Upload a file first.",
      });
      expect(analyzeText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("reuses a result committed between the gate and the lease", async () => {
      arrangeRunnableContract(
        contractRecord({ status: "ANALYZED", latestAnalysis: { id: ANALYSIS_ID } }),
      );

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        message: "Analysis already exists",
        jobId: "done",
        analysisId: ANALYSIS_ID,
      });
      expect(analyzeText).not.toHaveBeenCalled();
      expect(createAnalysisForContract).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("does not reuse an analysis for a contract that is not ANALYZED", async () => {
      arrangeRunnableContract(
        contractRecord({ status: "DRAFT", latestAnalysis: { id: ANALYSIS_ID } }),
      );

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ message: "Analysis complete" });
      expect(analyzeText).toHaveBeenCalledOnce();
    });

    it("lets a contract read failure reject and still releases the lease", async () => {
      arrangeRunnableContract();
      getContractWithLatestAnalysisForUser.mockRejectedValue(new Error("disk full"));

      await expect(POST(postRequest(), params(CONTRACT_ID))).rejects.toThrow("disk full");
      expect(analyzeText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });
  });

  describe("analysis", () => {
    it("analyzes the contract text and stores the result for the owner", async () => {
      arrangeRunnableContract();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
      analyzeText.mockImplementation(async () => {
        vi.setSystemTime(new Date("2026-10-01T10:00:02.500Z"));
        return analysisOutput();
      });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        message: "Analysis complete",
        jobId: "done",
        analysisId: NEW_ANALYSIS_ID,
      });
      expect(analyzeText).toHaveBeenCalledOnce();
      expect(analyzeText).toHaveBeenCalledWith(
        "This agreement is made between the parties.",
        undefined,
        {
          primaryModel: "gpt-5",
          signal: expect.any(AbortSignal),
          contextDocuments: [],
        },
      );
      expect(createAnalysisForContract).toHaveBeenCalledOnce();
      expect(createAnalysisForContract).toHaveBeenCalledWith({
        userId: "owner",
        contractId: CONTRACT_ID,
        expectedRevision: REVISION,
        riskBadge: "HIGH",
        resultJson: { risk_badge: "HIGH", summary: "Risky clauses found", coverage_notices: [] },
        llmProvider: "primary",
        llmModel: "gpt-5",
        llmPromptTokens: 1200,
        llmCompletionTokens: 340,
        processingTimeMs: 2500,
      });
      expect(release).toHaveBeenCalledOnce();
    });

    it("releases the lease only after the analysis has been persisted", async () => {
      arrangeRunnableContract();
      const order: string[] = [];
      createAnalysisForContract.mockImplementation(async () => {
        order.push("persist");
        return { id: NEW_ANALYSIS_ID };
      });
      release.mockImplementation(async () => {
        order.push("release");
      });

      await POST(postRequest(), params(CONTRACT_ID));

      expect(order).toEqual(["persist", "release"]);
    });

    it("passes a signal that follows the request abort signal", async () => {
      arrangeRunnableContract();
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      let abortedBeforeCancel: boolean | undefined;
      let abortedAfterCancel: boolean | undefined;
      analyzeText.mockImplementation(
        async (
          _text: string,
          _metadata: unknown,
          options: { signal: AbortSignal },
        ) => {
          receivedSignal = options.signal;
          abortedBeforeCancel = options.signal.aborted;
          controller.abort();
          abortedAfterCancel = options.signal.aborted;
          return analysisOutput();
        },
      );

      const response = await POST(
        postRequest("", { signal: controller.signal }),
        params(CONTRACT_ID),
      );

      expect(response.status).toBe(200);
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(abortedBeforeCancel).toBe(false);
      expect(abortedAfterCancel).toBe(true);
    });

    it("loads project context only for contracts that belong to a project", async () => {
      arrangeRunnableContract(contractRecord({ projectId: null }));

      await POST(postRequest(), params(CONTRACT_ID));

      expect(getProjectContextForAnalysis).not.toHaveBeenCalled();
    });

    it("passes owner-scoped project context documents to the model", async () => {
      arrangeRunnableContract(contractRecord({ projectId: PROJECT_ID }));
      getProjectContextForAnalysis.mockResolvedValue([
        {
          title: "Playbook",
          documentType: "PLAYBOOK",
          extractedText: "Never accept unlimited liability.",
          originalCharacterCount: 5000,
          extractionWarning: null,
        },
      ]);

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(getProjectContextForAnalysis).toHaveBeenCalledWith("owner", PROJECT_ID);
      expect(analyzeText).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({
          contextDocuments: [
            {
              title: "Playbook",
              documentType: "PLAYBOOK",
              text: "Never accept unlimited liability.",
              originalCharacterCount: 5000,
            },
          ],
        }),
      );
    });

    it("prepends extraction warnings from the contract and its context documents to the coverage notices", async () => {
      arrangeRunnableContract(
        contractRecord({
          projectId: PROJECT_ID,
          extractionWarning: "Scanned pages were skipped.",
        }),
      );
      getProjectContextForAnalysis.mockResolvedValue([
        {
          title: "Playbook",
          documentType: "PLAYBOOK",
          extractedText: "text",
          originalCharacterCount: 4,
          extractionWarning: "Truncated at 100 pages.",
        },
        {
          title: "Clean doc",
          documentType: "OTHER",
          extractedText: "text",
          originalCharacterCount: 4,
          extractionWarning: null,
        },
      ]);
      analyzeText.mockResolvedValue(
        analysisOutput({
          result: { risk_badge: "LOW", coverage_notices: ["Excerpted from the middle."] },
        }),
      );

      await POST(postRequest(), params(CONTRACT_ID));

      expect(createAnalysisForContract).toHaveBeenCalledWith(
        expect.objectContaining({
          resultJson: {
            risk_badge: "LOW",
            coverage_notices: [
              "Scanned pages were skipped.",
              "Playbook: Truncated at 100 pages.",
              "Excerpted from the middle.",
            ],
          },
        }),
      );
    });

    it("stores an empty coverage_notices list when there are no warnings or model notices", async () => {
      arrangeRunnableContract();
      analyzeText.mockResolvedValue(analysisOutput({ result: { risk_badge: "LOW" } }));

      await POST(postRequest(), params(CONTRACT_ID));

      expect(createAnalysisForContract).toHaveBeenCalledWith(
        expect.objectContaining({
          resultJson: { risk_badge: "LOW", coverage_notices: [] },
        }),
      );
    });

    it("stores null for a non-string risk badge and for missing provider and model", async () => {
      arrangeRunnableContract();
      analyzeText.mockResolvedValue(
        analysisOutput({
          result: { risk_badge: 3 },
          provider: undefined,
          model: undefined,
          promptTokens: null,
          completionTokens: null,
        }),
      );

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(createAnalysisForContract).toHaveBeenCalledWith(
        expect.objectContaining({
          riskBadge: null,
          llmProvider: null,
          llmModel: null,
          llmPromptTokens: null,
          llmCompletionTokens: null,
        }),
      );
    });

    it("returns 200 for a forced re-analysis", async () => {
      arrangeRunnableContract(
        contractRecord({ status: "ANALYZED", latestAnalysis: { id: ANALYSIS_ID } }),
      );

      const response = await POST(postRequest("?force=true"), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(createAnalysisForContract).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: CONTRACT_ID, expectedRevision: REVISION }),
      );
    });
  });

  describe("model selection", () => {
    it("uses the model pinned in the user's settings when it is available", async () => {
      arrangeRunnableContract();
      getUserSettingsByUserId.mockResolvedValue({ primaryModel: "gpt-5-mini" });

      await POST(postRequest(), params(CONTRACT_ID));

      expect(getUserSettingsByUserId).toHaveBeenCalledWith("owner");
      expect(analyzeText).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ primaryModel: "gpt-5-mini" }),
      );
    });

    it("falls back to the first available model when the pinned model is unavailable", async () => {
      arrangeRunnableContract();
      getUserSettingsByUserId.mockResolvedValue({ primaryModel: "retired-model" });

      await POST(postRequest(), params(CONTRACT_ID));

      expect(analyzeText).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ primaryModel: "gpt-5" }),
      );
    });

    it("passes a null model when the primary endpoint has no models available", async () => {
      arrangeRunnableContract();
      getModelAvailabilitySnapshot.mockResolvedValue({
        availablePrimaryModels: [],
        imageGenerationAvailable: false,
      });

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(analyzeText).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ primaryModel: null }),
      );
    });
  });

  describe("failures during analysis", () => {
    it("returns 409 when the contract revision changed while the model was running", async () => {
      arrangeRunnableContract();
      createAnalysisForContract.mockRejectedValue(new ContractRevisionChangedError());

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "The contract changed while analysis was running. Please analyze it again.",
      });
      expect(console.error).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("returns a generic 500 without leaking the model error, and persists nothing", async () => {
      arrangeRunnableContract();
      analyzeText.mockRejectedValue(new Error("upstream said: sk-secret-token rejected"));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "Analysis failed. Please try again." });
      expect(JSON.stringify(body)).not.toContain("sk-secret-token");
      expect(createAnalysisForContract).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith("Analysis error:", expect.any(Error));
      expect(release).toHaveBeenCalledOnce();
    });

    it("returns 500 when the model call is aborted by the request signal", async () => {
      arrangeRunnableContract();
      analyzeText.mockRejectedValue(new DOMException("This operation was aborted", "AbortError"));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Analysis failed. Please try again." });
      expect(createAnalysisForContract).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("returns 500 when persisting the analysis fails with a non-revision error", async () => {
      arrangeRunnableContract();
      createAnalysisForContract.mockRejectedValue(new Error("deadlock detected"));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Analysis failed. Please try again." });
      expect(release).toHaveBeenCalledOnce();
    });

    it("returns 500 when the user settings lookup fails, before calling the model", async () => {
      arrangeRunnableContract();
      getUserSettingsByUserId.mockRejectedValue(new Error("settings table unavailable"));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(500);
      expect(analyzeText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("returns 500 when the project context lookup fails, before calling the model", async () => {
      arrangeRunnableContract(contractRecord({ projectId: PROJECT_ID }));
      getProjectContextForAnalysis.mockRejectedValue(new Error("context query failed"));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(500);
      expect(analyzeText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("returns 500 when the model availability lookup fails", async () => {
      arrangeRunnableContract();
      getModelAvailabilitySnapshot.mockRejectedValue(new Error("models endpoint down"));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(500);
      expect(analyzeText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });
  });

  describe("lease release", () => {
    it("still returns the analysis result when releasing the lease fails", async () => {
      arrangeRunnableContract();
      const releaseError = new Error("release failed");
      release.mockRejectedValue(releaseError);

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        message: "Analysis complete",
        analysisId: NEW_ANALYSIS_ID,
      });
      expect(console.error).toHaveBeenCalledWith(
        "Analysis lease release failed",
        releaseError,
      );
    });

    it("keeps the mapped error response when releasing the lease also fails", async () => {
      arrangeRunnableContract();
      analyzeText.mockRejectedValue(new Error("model failed"));
      release.mockRejectedValue(new Error("release failed"));

      const response = await POST(postRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(500);
      expect(console.error).toHaveBeenCalledWith(
        "Analysis lease release failed",
        expect.any(Error),
      );
    });
  });
});
