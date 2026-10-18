import { describe, expect, it } from "vitest";
import {
  parseContractEvidence,
  validateContractReplay,
} from "./contract-evidence";

const id = "abcdef01-2345-4678-9abc-def012345678";
const metadata = {
  contractEvidence: [{ id, revision: "v1" }],
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
    expect(validateContractReplay(metadata, new Map([[id, "v1"]]))).toBe(
      metadata,
    );
  });
  it.each([new Map<string, string>(), new Map([[id, "v2"]])])(
    "drops private replay after deletion or replacement",
    (current) => {
      const result = validateContractReplay(metadata, current);
      expect(result.contractEvidenceInvalid).toBe(true);
      expect(result).not.toHaveProperty("agentMessages");
      expect(result).not.toHaveProperty("webSources");
    },
  );
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
      parseContractEvidence([{ id: "not-a-uuid", revision: "v1" }]),
    ).toBeNull();
    expect(
      parseContractEvidence([{ id: id.toUpperCase(), revision: "v1" }]),
    ).toEqual(metadata.contractEvidence);
    expect(
      validateContractReplay({ contractEvidence: [{}] }, new Map())
        .contractEvidenceInvalid,
    ).toBe(true);
  });
});
