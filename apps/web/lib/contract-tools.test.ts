import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server-db", () => ({ listContractsForChat: vi.fn(), getContractTextForUser: vi.fn() }));
import { getContractTextForUser, listContractsForChat } from "@/lib/server-db";
import {
  CONTRACT_EGRESS_ERROR,
  createContractEgressGuard,
} from "@repo/chat-engine/chat-tools";
import { createContractTools } from "./contract-tools";

it("exposes truncated keyword results and continuation through read_contract", async () => {
  const contractId = "11111111-1111-4111-8111-111111111111";
  vi.mocked(getContractTextForUser).mockResolvedValueOnce({
    id: contractId,
    title: "Long contract",
    revision: "2026-10-18T00:00:00.123456",
    status: "DRAFT",
    extractionWarning: null,
    text: Array.from({ length: 40 }, () => "indemnification " + "x".repeat(480)).join("\n"),
  });
  const tools = createContractTools({ userId: "owner", signal: new AbortController().signal });
  const result = await tools.read_contract!.execute!(
    { contractId, find: "indemnification" },
    { toolCallId: "read", messages: [], context: undefined },
  );

  expect(result).toMatchObject({ truncated: true, nextOffset: expect.any(Number) });
  expect(getContractTextForUser).toHaveBeenLastCalledWith("owner", contractId);
});

it("passes contract pagination and title search to the owner-scoped query", async () => {
  vi.mocked(listContractsForChat).mockResolvedValueOnce({ contracts: [], nextOffset: 50 })
    .mockResolvedValueOnce({ contracts: [], nextOffset: null });
  const tools = createContractTools({ userId: "owner", signal: new AbortController().signal });
  const execute = tools.list_contracts!.execute!;
  expect(await execute({ query: "NDA" }, { toolCallId: "a", messages: [], context: undefined }))
    .toMatchObject({ hasMore: true, nextOffset: 50 });
  expect(await execute({ query: "NDA", offset: 50 }, { toolCallId: "b", messages: [], context: undefined }))
    .toMatchObject({ hasMore: false, nextOffset: null });
  expect(listContractsForChat).toHaveBeenLastCalledWith("owner", { query: "NDA", offset: 50 });
});

describe("contract egress guard", () => {
  const clause =
    "The Receiving Party shall keep all Confidential Information strictly secret for five years after termination.";

  it("learns contract text from read_contract excerpts", async () => {
    const contractId = "22222222-2222-4222-8222-222222222222";
    vi.mocked(getContractTextForUser).mockResolvedValueOnce({
      id: contractId,
      title: "NDA",
      status: "DRAFT",
      extractionWarning: null,
      revision: "2026-10-18T00:00:00.123456",
      text: `Clause 4. ${clause}`,
    });
    const guard = createContractEgressGuard();
    const tools = createContractTools({ userId: "owner", signal: new AbortController().signal, egressGuard: guard });
    expect(guard.check(clause)).toBeNull();
    await tools.read_contract!.execute!(
      { contractId, find: "confidential" },
      { toolCallId: "read", messages: [], context: undefined },
    );
    expect(guard.check(clause)).toEqual({ error: CONTRACT_EGRESS_ERROR });
  });
});
