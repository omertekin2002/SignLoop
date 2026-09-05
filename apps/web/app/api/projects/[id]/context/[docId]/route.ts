import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  deleteContextDocumentFromProject,
} from "@/lib/server-db";
import { flushStorageDeletions } from "@/lib/storage-cleanup";
import { after } from "next/server";
import { isUuid } from "@/lib/utils";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id, docId } = await params;
  if (!isUuid(id) || !isUuid(docId)) {
    return NextResponse.json(
      { error: "Context document not found" },
      { status: 404 },
    );
  }

  const result = await deleteContextDocumentFromProject({
    userId,
    projectId: id,
    documentId: docId,
  });

  if (!result.deleted) {
    return NextResponse.json(
      { error: "Context document not found" },
      { status: 404 },
    );
  }

  after(() => flushStorageDeletions().then(() => {}));
  return NextResponse.json({ success: true });
}
