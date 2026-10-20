import { isRecord, isUuid } from "@/lib/utils";

export type ContractEvidence = { id: string; revision: string };
/**
 * `content` is the SHA-256 text identity issued by the chat tools. `updatedAt` verifies receipts
 * saved before that: the timestamp also moves on analysis and project-context changes, so an
 * unchanged value proves the text is unchanged and anything else fails closed.
 */
export type CurrentContractRevision = { content: string; updatedAt: string };
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

function isCurrentReceipt(
  ref: ContractEvidence,
  current: ReadonlyMap<string, CurrentContractRevision>,
): boolean {
  const revision = current.get(ref.id);
  if (!revision) return false;
  return ref.revision.startsWith("sha256:")
    ? ref.revision === revision.content
    : ref.revision === revision.updatedAt;
}

/**
 * Saved receipts are server-generated: only the chat route writes them, from the generator's own
 * list. An explicit empty list on a contract-tool turn is a verified "nothing was read" (an empty
 * listing or a missing contract). Tool turns without the key predate receipts and fail closed.
 * Verified timestamp receipts are returned as content receipts, so followups do not inherit them.
 */
export function validateContractReplay(
  metadata: Record<string, unknown>,
  current: ReadonlyMap<string, CurrentContractRevision>,
): Record<string, unknown> {
  const evidence = parseContractEvidence(metadata.contractEvidence);
  const stale =
    metadata.contractEvidenceInvalid === true ||
    (metadata.contractEvidence !== undefined && evidence === null) ||
    (hasContractTools(metadata) && metadata.contractEvidence === undefined) ||
    evidence?.some((ref) => !isCurrentReceipt(ref, current));
  if (!stale) {
    if (!evidence?.some((ref) => !ref.revision.startsWith("sha256:")))
      return metadata;
    const upgraded = new Map(
      evidence.map((ref) => [ref.id, { id: ref.id, revision: current.get(ref.id)!.content }]),
    );
    return { ...metadata, contractEvidence: [...upgraded.values()] };
  }
  // Preserve visible historical replies, but never send their prose or tools back to a model.
  const { agentMessages: _agent, webSources: _sources, ...rest } = metadata;
  return { ...rest, contractEvidenceInvalid: true };
}
