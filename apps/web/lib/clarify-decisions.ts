import { z } from "zod";
import { clarifyBeforeSigning } from "@/lib/analysis-clarify";
import { clarifyChecklistKeys } from "@/lib/clarify-keys";
import type { AnalysisResult } from "@/lib/schemas";

/**
 * The owner's decisions on "Before you sign" items. A decision is the owner's own record: it is
 * never sent to a model and never changes an analysis or its checklist. Limits are in Unicode code
 * points, matching migration 025's char_length checks.
 */
export const CLARIFY_DECISION_STATES = ["resolved", "accepted", "open"] as const;
export type ClarifyDecisionState = (typeof CLARIFY_DECISION_STATES)[number];

/** How each state is named on the page and in the decision brief. */
export const CLARIFY_DECISION_STATE_LABELS: Record<ClarifyDecisionState, string> = {
  resolved: "Resolved",
  accepted: "Accepted",
  open: "Still open",
};

export const CLARIFY_DECISION_REASON_MAX_CHARACTERS = 2_000;
export const CLARIFY_DECISION_LABEL_MAX_CHARACTERS = 500;
export const CLARIFY_DECISION_KEY_MAX_CHARACTERS = 200;

/** The shape of a `lib/clarify-keys.ts` key, as migration 025 checks it. */
const ITEM_KEY_PATTERN = /^v[0-9]+:[a-z]+:[a-z0-9:-]+$/;

const codePoints = (value: string) => [...value].length;
const noNul = (value: string) => !value.includes("\u0000");

const ItemKeySchema = z
  .string()
  .max(CLARIFY_DECISION_KEY_MAX_CHARACTERS)
  .regex(ITEM_KEY_PATTERN);

const ReasonSchema = z
  .string()
  .refine(noNul, "A reason cannot contain NUL characters")
  .refine(
    (value) => codePoints(value) <= CLARIFY_DECISION_REASON_MAX_CHARACTERS,
    `A reason is at most ${CLARIFY_DECISION_REASON_MAX_CHARACTERS} characters`,
  );

const LabelSchema = z
  .string()
  .refine(noNul, "A label cannot contain NUL characters")
  .refine((value) => value.trim().length > 0, "A label cannot be empty")
  .refine(
    (value) => codePoints(value) <= CLARIFY_DECISION_LABEL_MAX_CHARACTERS,
    `A label is at most ${CLARIFY_DECISION_LABEL_MAX_CHARACTERS} characters`,
  );

const RevisionSchema = z.iso.datetime({ offset: true });

// The source revision is not accepted: the server reads it from the stored analysis.
// expectedUpdatedAt is the updatedAt the client last read: null when the item had no decision yet.
const ClarifyDecisionSaveSchema = z.strictObject({
  analysisId: z.uuid(),
  itemKey: ItemKeySchema,
  state: z.enum(CLARIFY_DECISION_STATES),
  reason: ReasonSchema,
  itemLabel: LabelSchema,
  expectedUpdatedAt: RevisionSchema.nullable(),
});

export type ClarifyDecisionSave = z.infer<typeof ClarifyDecisionSaveSchema>;

/** Validate a `PUT /api/contracts/:id/decisions` body; null when it is malformed or too long. */
export function parseClarifyDecisionSave(body: unknown): ClarifyDecisionSave | null {
  const parsed = ClarifyDecisionSaveSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

const ClarifyDecisionDeleteSchema = z.strictObject({
  expectedUpdatedAt: RevisionSchema,
});

/** Validate a `DELETE /api/contracts/:id/decisions/:decisionId` body; null when it is malformed. */
export function parseClarifyDecisionDelete(
  body: unknown,
): z.infer<typeof ClarifyDecisionDeleteSchema> | null {
  const parsed = ClarifyDecisionDeleteSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether `itemKey` names exactly one item of the stored analysis's "Before you sign" checklist,
 * rebuilt as the page builds it. Coverage gaps have no key, so they never take a decision; an
 * ambiguous key names more than one item, so no decision may attach to it.
 */
export function clarifyItemKeyStatus(
  contractId: string,
  resultJson: unknown,
  itemKey: string,
): "ok" | "unknown" | "ambiguous" {
  const result = resultJson as Partial<AnalysisResult> | null;
  const checklist = clarifyBeforeSigning({ contractId, resultJson: result });
  const keys = clarifyChecklistKeys(checklist, { contractId, resultJson: result });
  const items = [...keys.unverified, ...keys.unstated, ...keys.findings, ...keys.questions].filter(
    (item) => item.key === itemKey,
  );
  if (!items.length) return "unknown";
  return items.some((item) => item.ambiguous) ? "ambiguous" : "ok";
}
