import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { deleteAnalysisForContract, getAnalysisForUser } from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; analysisId: string }> }) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { id, analysisId } = await params;
  if (!isUuid(id) || !isUuid(analysisId)) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  const analysis = await getAnalysisForUser(authed.userId, id, analysisId);
  return analysis ? NextResponse.json(analysis) : NextResponse.json({ error: "Analysis not found" }, { status: 404 });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; analysisId: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id, analysisId } = await params;
  if (!isUuid(id) || !isUuid(analysisId)) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }
  const deleted = await deleteAnalysisForContract({
    userId,
    contractId: id,
    analysisId,
  });

  if (!deleted) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
