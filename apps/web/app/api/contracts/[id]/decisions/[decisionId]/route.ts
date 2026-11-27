import { NextResponse } from "next/server";
import { parseJsonBody, requireUserId } from "@/lib/api-auth";
import { parseClarifyDecisionDelete } from "@/lib/clarify-decisions";
import { deleteClarifyDecisionForUser } from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

/**
 * Delete one of the owner's decisions: `{ "expectedUpdatedAt": string }`, the decision's
 * `updatedAt` last read. A decision changed since then returns 409 with the stored decision and
 * stays.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; decisionId: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id, decisionId } = await params;
  if (!isUuid(id) || !isUuid(decisionId)) {
    return NextResponse.json({ error: "Decision not found" }, { status: 404 });
  }
  const body = parseClarifyDecisionDelete(await parseJsonBody<unknown>(req));
  if (!body) {
    return NextResponse.json(
      { error: 'Send { "expectedUpdatedAt": the updatedAt you last read }.' },
      { status: 400 },
    );
  }

  const result = await deleteClarifyDecisionForUser(userId, id, decisionId, body.expectedUpdatedAt);
  switch (result.status) {
    case "not_found":
      return NextResponse.json({ error: "Decision not found" }, { status: 404 });
    case "conflict":
      return NextResponse.json(
        {
          error: "This decision was changed elsewhere. Reload it before deleting it.",
          decision: result.decision,
        },
        { status: 409 },
      );
    case "deleted":
      return NextResponse.json({ success: true });
  }
}
