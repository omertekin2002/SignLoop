import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { deleteAnalysisForContract, getContractMetaForUser } from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { id } = await params;
  const keepAnalysisId = new URL(req.url).searchParams.get("keep");
  if (!isUuid(id) || !keepAnalysisId || !isUuid(keepAnalysisId)) {
    return NextResponse.json({ error: "Invalid analysis selection" }, { status: 400 });
  }
  if (!await getContractMetaForUser(authed.userId, id)) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  await deleteAnalysisForContract({ userId: authed.userId, contractId: id, keepAnalysisId });
  return NextResponse.json({ success: true });
}
