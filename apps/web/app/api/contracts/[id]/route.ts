import { NextResponse } from 'next/server';
import { auth } from "@clerk/nextjs/server";
import { deleteContractForUser, getContractByIdForUser, getContractStorageKeys } from "@/lib/server-db";
import { deleteObject } from "@/lib/object-storage";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const contract = await getContractByIdForUser(userId, id);
  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }
  return NextResponse.json(contract);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Collect storage keys while DB records still exist, then delete storage
  // before the DB transaction. If the app crashes after storage cleanup but
  // before the DB delete, the user can retry and the DB delete will succeed
  // (storage deletes are idempotent no-ops for missing files).
  const storageKeys = await getContractStorageKeys(userId, id);
  await Promise.allSettled(storageKeys.map((key) => deleteObject(key)));

  const result = await deleteContractForUser({ userId, contractId: id });

  if (!result.deleted) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
