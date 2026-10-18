import { isRecord, isUuid } from "@/lib/utils";

export type ContractEvidence = { id: string; revision: string };
export const STALE_CONTRACT_REPLY =
  "A previous answer used contract evidence that changed, was deleted, or cannot be verified. Read the current contracts again; do not rely on that historical answer.";

export function parseContractEvidence(
  value: unknown,
): ContractEvidence[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const references: ContractEvidence[] = [];
  for (const ref of value) {
    if (
      !isRecord(ref) ||
      !isUuid(ref.id) ||
      typeof ref.revision !== "string" ||
      !ref.revision.trim() ||
      ref.revision.length > 100
    )
      return null;
    references.push({
      id: (ref.id as string).toLowerCase(),
      revision: ref.revision,
    });
  }
  return references;
}

function hasContractTools(metadata: Record<string, unknown>): boolean {
  const isContractTool = (name: unknown) =>
    name === "read_contract" || name === "list_contracts";
  if (
    Array.isArray(metadata.toolActivity) &&
    metadata.toolActivity.some(
      (item) => isRecord(item) && isContractTool(item.tool),
    )
  )
    return true;
  return (
    Array.isArray(metadata.agentMessages) &&
    metadata.agentMessages.some(
      (message) =>
        isRecord(message) &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => isRecord(part) && isContractTool(part.toolName),
        ),
    )
  );
}

/** Saved receipts are server-generated. Missing receipts on legacy tool turns fail closed. */
export function validateContractReplay(
  metadata: Record<string, unknown>,
  current: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const evidence = parseContractEvidence(metadata.contractEvidence);
  const stale =
    metadata.contractEvidenceInvalid === true ||
    (metadata.contractEvidence !== undefined && evidence === null) ||
    (hasContractTools(metadata) && !evidence?.length) ||
    evidence?.some((ref) => current.get(ref.id) !== ref.revision);
  if (!stale) return metadata;
  // Preserve visible historical replies, but never send their prose or tools back to a model.
  const { agentMessages: _agent, webSources: _sources, ...rest } = metadata;
  return { ...rest, contractEvidenceInvalid: true };
}
