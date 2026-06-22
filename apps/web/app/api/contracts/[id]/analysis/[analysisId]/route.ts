import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { deleteAnalysisForContract } from "@/lib/server-db";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; analysisId: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id, analysisId } = await params;
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
