import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  deleteContractForUser,
  getContractByIdForUser,
} from "@/lib/server-db";
import { flushStorageDeletions } from "@/lib/storage-cleanup";
import { after } from "next/server";
import { isUuid } from "@/lib/utils";

export async function GET(
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
  const contract = await getContractByIdForUser(userId, id);
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // The detail UI renders analysis metadata and never consumes the extracted source text.
  // Keep that potentially large, confidential payload server-side for the analysis route.
  return NextResponse.json(contract);
}

export async function DELETE(
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

  const result = await deleteContractForUser({ userId, contractId: id });

  if (!result.deleted) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  after(() => flushStorageDeletions().then(() => {}));
  return NextResponse.json({ success: true });
}
