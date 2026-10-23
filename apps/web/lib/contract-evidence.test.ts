import { describe, expect, it } from "vitest";
import {
  parseContractEvidence,
  validateContractReplay,
  type CurrentContractRevision,
} from "./contract-evidence";

const id = "abcdef01-2345-4678-9abc-def012345678";
const v1 = `sha256:${"1".repeat(64)}`;
const v2 = `sha256:${"2".repeat(64)}`;
const savedAt = "2026-10-18T00:00:00.123456";
const current = (content: string, updatedAt = savedAt) =>
  new Map<string, CurrentContractRevision>([[id, { content, updatedAt }]]);
const metadata = {
  contractEvidence: [{ id, revision: v1 }],
  agentMessages: [
    {
      role: "tool",
      content: [{ toolName: "read_contract", output: "private text" }],
    },
  ],
  webSources: [{ title: "Private title" }],
};
describe("contract evidence freshness", () => {
  it("keeps a current receipt", () => {
    expect(validateContractReplay(metadata, current(v1))).toBe(metadata);
  });
  it("ignores operation timestamps for content receipts", () => {
    expect(
      validateContractReplay(metadata, current(v1, "2026-10-19T00:00:00.000000")),
    ).toBe(metadata);
  });
  it.each([new Map<string, CurrentContractRevision>(), current(v2)])(
    "drops private replay after deletion or replacement",
    (current) => {
      const result = validateContractReplay(metadata, current);
      expect(result.contractEvidenceInvalid).toBe(true);
      expect(result).not.toHaveProperty("agentMessages");
      expect(result).not.toHaveProperty("webSources");
    },
  );
  it("accepts a legacy timestamp receipt only while the timestamp is unchanged", () => {
    const legacy = { ...metadata, contractEvidence: [{ id, revision: savedAt }, { id, revision: v1 }] };
    expect(validateContractReplay(legacy, current(v1))).toEqual({
      ...metadata,
      contractEvidence: [{ id, revision: v1 }],
    });
    // A later analysis, context change, or upload: unchanged text cannot be proven, so fail closed.
    const moved = validateContractReplay(legacy, current(v1, "2026-10-19T00:00:00.000000"));
    expect(moved.contractEvidenceInvalid).toBe(true);
    expect(moved).not.toHaveProperty("agentMessages");
    // A timestamp never satisfies a content receipt, and vice versa.
    expect(
      validateContractReplay(metadata, current(savedAt, savedAt)).contractEvidenceInvalid,
    ).toBe(true);
    expect(
      validateContractReplay({ contractEvidence: [{ id, revision: v1 }] }, current(v2, v1))
        .contractEvidenceInvalid,
    ).toBe(true);
  });
  it("rejects legacy/clipped contract turns without receipts", () => {
    expect(
      validateContractReplay(
        { agentMessages: metadata.agentMessages },
        new Map(),
      ).contractEvidenceInvalid,
    ).toBe(true);
    expect(
      validateContractReplay(
        { toolActivity: [{ tool: "read_contract" }] },
        new Map(),
      ).contractEvidenceInvalid,
    ).toBe(true);
  });
  it("keeps a contract-tool turn whose explicit receipt list is empty", () => {
    // An empty listing and a missing contract: the server read no contract text.
    const nothingRead = {
      contractEvidence: [],
      toolActivity: [
        { id: "c1", tool: "list_contracts", query: "", status: "complete" },
        { id: "c2", tool: "read_contract", query: id, status: "error" },
      ],
      agentMessages: [
        {
          role: "tool",
          content: [
            { toolName: "list_contracts", output: { contracts: [] } },
            { toolName: "read_contract", output: { error: "Contract not found." } },
          ],
        },
      ],
    };
    expect(validateContractReplay(nothingRead, new Map())).toBe(nothingRead);
    expect(validateContractReplay(nothingRead, current(v1))).toBe(nothingRead);
    // Only the key's presence vouches for "nothing read"; null, malformed, or a prior verdict do not.
    for (const contractEvidence of [null, {}, [{}], [{ id, revision: "" }], "[]"]) {
      const result = validateContractReplay({ ...nothingRead, contractEvidence }, new Map());
      expect(result.contractEvidenceInvalid).toBe(true);
      expect(result).not.toHaveProperty("agentMessages");
    }
    expect(
      validateContractReplay({ ...nothingRead, contractEvidenceInvalid: true }, new Map())
        .contractEvidenceInvalid,
    ).toBe(true);
    const { contractEvidence: _absent, ...legacy } = nothingRead;
    expect(validateContractReplay(legacy, new Map()).contractEvidenceInvalid).toBe(true);
    expect(
      validateContractReplay({ ...legacy, contractEvidence: undefined }, new Map())
        .contractEvidenceInvalid,
    ).toBe(true);
  });
  it("invalidates dependent follow-ups even without new tool calls", () => {
    expect(
      validateContractReplay(
        { contractEvidence: metadata.contractEvidence },
        new Map(),
      ).contractEvidenceInvalid,
    ).toBe(true);
  });
  it("preserves ordinary conversation and rejects malformed receipts", () => {
    expect(validateContractReplay({}, new Map())).toEqual({});
    expect(
      parseContractEvidence([{ id: "not-a-uuid", revision: v1 }]),
    ).toBeNull();
    expect(
      parseContractEvidence([{ id: id.toUpperCase(), revision: v1 }]),
    ).toEqual(metadata.contractEvidence);
    expect(
      validateContractReplay({ contractEvidence: [{}] }, new Map())
        .contractEvidenceInvalid,
    ).toBe(true);
  });
});
