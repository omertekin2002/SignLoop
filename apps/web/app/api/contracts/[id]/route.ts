import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  deleteContractForUser,
  getContractByIdForUser,
  getContractStorageKeys,
} from "@/lib/server-db";
import { deleteObjects } from "@/lib/object-storage";
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
  return NextResponse.json({ ...contract, text: undefined });
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

  // Collect storage keys while DB records still exist, then delete storage
  // before the DB transaction. If the app crashes after storage cleanup but
  // before the DB delete, the user can retry and the DB delete will succeed
  // (storage deletes are idempotent no-ops for missing files).
  const storageKeys = await getContractStorageKeys(userId, id);
  try {
    await deleteObjects(storageKeys);
  } catch (error: unknown) {
    console.error(
      "Failed to delete contract storage before database cleanup:",
      error,
    );
    return NextResponse.json(
      { error: "Could not remove the contract file. Please retry." },
      { status: 502 },
    );
  }

  const result = await deleteContractForUser({ userId, contractId: id });

  if (!result.deleted) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
