import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { deleteContextDocumentFromProject, getContextDocumentStorageKey } from "@/lib/server-db";
import { deleteObject } from "@/lib/object-storage";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, docId } = await params;

  // Delete storage while DB reference still exists so a crash leaves a
  // retryable DB record instead of a permanently orphaned file.
  const storageKey = await getContextDocumentStorageKey(userId, id, docId);
  if (storageKey) {
    await deleteObject(storageKey);
  }

  const result = await deleteContextDocumentFromProject({
    userId,
    projectId: id,
    documentId: docId,
  });

  if (!result.deleted) {
    return NextResponse.json({ error: "Context document not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
