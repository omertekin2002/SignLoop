import { afterEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  listClarifyDecisionsForUser,
  saveClarifyDecisionForUser,
  deleteClarifyDecisionForUser,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  listClarifyDecisionsForUser: vi.fn(),
  saveClarifyDecisionForUser: vi.fn(),
  deleteClarifyDecisionForUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  listClarifyDecisionsForUser,
  saveClarifyDecisionForUser,
  deleteClarifyDecisionForUser,
}));

import { GET, PUT } from "@/app/api/contracts/[id]/decisions/route";
import { DELETE } from "@/app/api/contracts/[id]/decisions/[decisionId]/route";
import { CLARIFY_DECISION_REASON_MAX_CHARACTERS } from "@/lib/clarify-decisions";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const ANALYSIS_ID = "5b0c7f36-8d0a-4f8e-9a52-0f5d9a3c1e21";
const DECISION_ID = "9f1d2c3b-4a5e-4f60-8172-839405162738";
const SAVED_AT = "2026-11-27T09:00:00.123Z";
const REVISION = `sha256:${"a".repeat(64)}`;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const deleteParams = (id: string, decisionId: string) => ({
  params: Promise.resolve({ id, decisionId }),
});
const url = `http://localhost/api/contracts/${CONTRACT_ID}/decisions`;
const request = (method: string, body?: unknown, target = url) =>
  new Request(target, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const input = {
  analysisId: ANALYSIS_ID,
  itemKey: "v1:unstated:term",
  state: "accepted",
  reason: "Monthly is fine.",
  itemLabel: "Term: Not specified",
};
const record = (overrides: Record<string, unknown> = {}) => ({
  id: DECISION_ID,
  contractId: CONTRACT_ID,
  ...input,
  sourceRevision: REVISION,
  createdAt: SAVED_AT,
  updatedAt: SAVED_AT,
  ...overrides,
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/contracts/[id]/decisions", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(request("GET"), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(listClarifyDecisionsForUser).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "../../etc/passwd", `${CONTRACT_ID}-extra`, ""])(
    "returns 404 for the id %j without querying the database",
    async (id) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await GET(request("GET"), params(id));

      expect(response.status).toBe(404);
      expect(listClarifyDecisionsForUser).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the contract is missing or belongs to another user", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    listClarifyDecisionsForUser.mockResolvedValue(null);

    const response = await GET(request("GET"), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(listClarifyDecisionsForUser).toHaveBeenCalledWith("intruder", CONTRACT_ID);
  });

  it("lists the owner's decisions, empty before the first", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    listClarifyDecisionsForUser.mockResolvedValueOnce([]);
    const empty = await GET(request("GET"), params(CONTRACT_ID));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ decisions: [] });

    listClarifyDecisionsForUser.mockResolvedValueOnce([record(), record({ id: "older", analysisId: null })]);
    const response = await GET(request("GET"), params(CONTRACT_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decisions: [record(), record({ id: "older", analysisId: null })] });
    expect(listClarifyDecisionsForUser).toHaveBeenCalledWith("owner", CONTRACT_ID);
  });
});

describe("PUT /api/contracts/[id]/decisions", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await PUT(request("PUT", { ...input, expectedUpdatedAt: null }), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(saveClarifyDecisionForUser).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed id without querying the database", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PUT(request("PUT", { ...input, expectedUpdatedAt: null }), params("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(saveClarifyDecisionForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{"],
    ["an empty body", ""],
    ["a missing expectedUpdatedAt", input],
    ["a client-chosen source revision", { ...input, sourceRevision: REVISION, expectedUpdatedAt: null }],
    ["an unknown field", { ...input, userId: "intruder", expectedUpdatedAt: null }],
    ["a bad state", { ...input, state: "ignored", expectedUpdatedAt: null }],
    ["a malformed analysis id", { ...input, analysisId: "a1", expectedUpdatedAt: null }],
    ["a malformed key", { ...input, itemKey: "Term", expectedUpdatedAt: null }],
    ["a reason over the limit", { ...input, reason: "a".repeat(CLARIFY_DECISION_REASON_MAX_CHARACTERS + 1), expectedUpdatedAt: null }],
    ["a NUL character", { ...input, reason: "a\u0000b", expectedUpdatedAt: null }],
  ])("returns 400 for %s without saving", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PUT(request("PUT", body), params(CONTRACT_ID));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(String(CLARIFY_DECISION_REASON_MAX_CHARACTERS));
    expect(saveClarifyDecisionForUser).not.toHaveBeenCalled();
  });

  it("returns 404 when the contract or analysis is missing or another user's", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    saveClarifyDecisionForUser.mockResolvedValue({ status: "not_found" });

    const response = await PUT(request("PUT", { ...input, expectedUpdatedAt: null }), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract or analysis not found" });
    expect(saveClarifyDecisionForUser).toHaveBeenCalledWith("intruder", CONTRACT_ID, input, null);
  });

  it.each([
    ["no_revision", /no source revision/],
    ["unknown_item", /not on this analysis/],
    ["ambiguous_item", /more than one item/],
  ])("returns 422 for %s", async (status, message) => {
    auth.mockResolvedValue({ userId: "owner" });
    saveClarifyDecisionForUser.mockResolvedValue({ status });

    const response = await PUT(request("PUT", { ...input, expectedUpdatedAt: null }), params(CONTRACT_ID));

    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(message);
  });

  it("returns 409 with the stored decision when another save overtook this one", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    const newer = record({ state: "resolved", updatedAt: "2026-11-27T09:05:00.000Z" });
    saveClarifyDecisionForUser.mockResolvedValue({ status: "conflict", decision: newer });

    const response = await PUT(request("PUT", { ...input, expectedUpdatedAt: SAVED_AT }), params(CONTRACT_ID));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.decision).toEqual(newer);
    expect(body.error).toMatch(/changed elsewhere/);
    expect(saveClarifyDecisionForUser).toHaveBeenCalledWith("owner", CONTRACT_ID, input, SAVED_AT);
  });

  it("returns 409 with a null decision when the decision it expected is gone", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    saveClarifyDecisionForUser.mockResolvedValue({ status: "conflict", decision: null });

    const response = await PUT(request("PUT", { ...input, expectedUpdatedAt: SAVED_AT }), params(CONTRACT_ID));

    expect(response.status).toBe(409);
    expect((await response.json()).decision).toBeNull();
  });

  it("saves the decision and returns it with its revision", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    saveClarifyDecisionForUser.mockResolvedValue({ status: "saved", decision: record() });

    const response = await PUT(request("PUT", { ...input, expectedUpdatedAt: null }), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(record());
    expect(saveClarifyDecisionForUser).toHaveBeenCalledWith("owner", CONTRACT_ID, input, null);
  });

  it("lets a database failure reject instead of mapping it to a response", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    saveClarifyDecisionForUser.mockRejectedValue(new Error("connection lost"));

    await expect(
      PUT(request("PUT", { ...input, expectedUpdatedAt: null }), params(CONTRACT_ID)),
    ).rejects.toThrow("connection lost");
  });
});

describe("DELETE /api/contracts/[id]/decisions/[decisionId]", () => {
  const target = `${url}/${DECISION_ID}`;
  const body = { expectedUpdatedAt: SAVED_AT };

  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await DELETE(request("DELETE", body, target), deleteParams(CONTRACT_ID, DECISION_ID));

    expect(response.status).toBe(401);
    expect(deleteClarifyDecisionForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["contract", "not-a-uuid", DECISION_ID],
    ["decision", CONTRACT_ID, "not-a-uuid"],
  ])("returns 404 for a malformed %s id without querying the database", async (_label, id, decisionId) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await DELETE(request("DELETE", body, target), deleteParams(id, decisionId));

    expect(response.status).toBe(404);
    expect(deleteClarifyDecisionForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["invalid JSON", "{"],
    ["a null revision", { expectedUpdatedAt: null }],
    ["an unknown field", { ...body, userId: "intruder" }],
  ])("returns 400 for %s without deleting", async (_label, payload) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await DELETE(request("DELETE", payload, target), deleteParams(CONTRACT_ID, DECISION_ID));

    expect(response.status).toBe(400);
    expect(deleteClarifyDecisionForUser).not.toHaveBeenCalled();
  });

  it("returns 404 when the decision is missing or another user's", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    deleteClarifyDecisionForUser.mockResolvedValue({ status: "not_found" });

    const response = await DELETE(request("DELETE", body, target), deleteParams(CONTRACT_ID, DECISION_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Decision not found" });
    expect(deleteClarifyDecisionForUser).toHaveBeenCalledWith("intruder", CONTRACT_ID, DECISION_ID, SAVED_AT);
  });

  it("returns 409 with the stored decision when it changed since it was read", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    const newer = record({ updatedAt: "2026-11-27T09:05:00.000Z" });
    deleteClarifyDecisionForUser.mockResolvedValue({ status: "conflict", decision: newer });

    const response = await DELETE(request("DELETE", body, target), deleteParams(CONTRACT_ID, DECISION_ID));

    expect(response.status).toBe(409);
    expect((await response.json()).decision).toEqual(newer);
  });

  it("deletes the decision", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    deleteClarifyDecisionForUser.mockResolvedValue({ status: "deleted" });

    const response = await DELETE(request("DELETE", body, target), deleteParams(CONTRACT_ID, DECISION_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(deleteClarifyDecisionForUser).toHaveBeenCalledWith("owner", CONTRACT_ID, DECISION_ID, SAVED_AT);
  });
});
