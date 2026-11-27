import { NextResponse } from "next/server";
import { parseJsonBody, requireUserId } from "@/lib/api-auth";
import {
  CLARIFY_DECISION_LABEL_MAX_CHARACTERS,
  CLARIFY_DECISION_REASON_MAX_CHARACTERS,
  parseClarifyDecisionSave,
} from "@/lib/clarify-decisions";
import {
  listClarifyDecisionsForUser,
  saveClarifyDecisionForUser,
} from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

/**
 * The owner's decisions on the contract's "Before you sign" items, oldest first: those on the
 * current analysis's items and those left from earlier analyses. They are never sent to a model.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  const decisions = await listClarifyDecisionsForUser(userId, id);
  if (!decisions) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  return NextResponse.json({ decisions });
}

/**
 * Save a decision: `{ "analysisId": uuid, "itemKey": string, "state": "resolved" | "accepted" |
 * "open", "reason": string, "itemLabel": string, "expectedUpdatedAt": string | null }`, where
 * `expectedUpdatedAt` is the decision's `updatedAt` last read, or null for an item with no decision
 * yet. The source revision comes from the stored analysis. A key that names no item of that
 * analysis's checklist, or more than one, returns 422; a save another save has overtaken returns
 * 409 with the stored decision and changes nothing.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  const save = parseClarifyDecisionSave(await parseJsonBody<unknown>(req));
  if (!save) {
    return NextResponse.json(
      {
        error: `Send { "analysisId": the analysis id, "itemKey": the item's key, "state": "resolved", "accepted" or "open", "reason": text of at most ${CLARIFY_DECISION_REASON_MAX_CHARACTERS} characters, "itemLabel": the item's wording, at most ${CLARIFY_DECISION_LABEL_MAX_CHARACTERS} characters, "expectedUpdatedAt": the updatedAt you last read, or null }.`,
      },
      { status: 400 },
    );
  }

  const { expectedUpdatedAt, ...input } = save;
  const result = await saveClarifyDecisionForUser(userId, id, input, expectedUpdatedAt);
  switch (result.status) {
    case "not_found":
      return NextResponse.json({ error: "Contract or analysis not found" }, { status: 404 });
    case "no_revision":
      return NextResponse.json(
        { error: "This analysis has no source revision. Re-analyse the contract to record decisions." },
        { status: 422 },
      );
    case "unknown_item":
      return NextResponse.json(
        { error: "That item is not on this analysis's Before you sign list." },
        { status: 422 },
      );
    case "ambiguous_item":
      return NextResponse.json(
        { error: "That key names more than one item on this analysis's Before you sign list." },
        { status: 422 },
      );
    case "conflict":
      return NextResponse.json(
        {
          error: "This decision was changed elsewhere. Reload it before saving again.",
          decision: result.decision,
        },
        { status: 409 },
      );
    case "saved":
      return NextResponse.json(result.decision);
  }
}
