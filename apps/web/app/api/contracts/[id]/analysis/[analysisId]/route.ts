import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { deleteAnalysisForContract } from "@/lib/server-db";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; analysisId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
