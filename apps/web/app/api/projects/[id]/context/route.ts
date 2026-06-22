import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { addContextDocumentToProject, getProjectByIdForUser } from "@/lib/server-db";
import { prepareUpload, storeUploadedFile } from "@/lib/upload-pipeline";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  const project = await getProjectByIdForUser(userId, id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({
    data: project.contextDocuments,
    total: project.contextDocuments.length,
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;

  const prepared = await prepareUpload(req);
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: prepared.status });
  }

  const titleValue = prepared.formData.get("title");
  const documentTypeValue = prepared.formData.get("documentType");
  const title =
    typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : prepared.file.name;
  const documentType =
    typeof documentTypeValue === "string" && documentTypeValue.trim()
      ? documentTypeValue.trim()
      : "other";

  // Context documents are still stored when extraction yields no text (unlike contracts), but
  // the failure is surfaced in the response so the client can warn instead of it being silent.
  const extractionFailed = Boolean(prepared.extractionError) || prepared.text.trim().length === 0;
  const extractionMethod = extractionFailed ? "extraction_failed" : prepared.method;

  const { storageKey, bucket } = await storeUploadedFile({
    buffer: prepared.buffer,
    mimeType: prepared.mimeType,
    storageKeyPrefix: `projects/${userId}/${id}/context`,
    fileName: prepared.file.name,
  });

  try {
    const wordCount = prepared.text.split(/\s+/).filter(Boolean).length;
    const created = await addContextDocumentToProject({
      userId,
      projectId: id,
      title,
      documentType,
      storageKey,
      bucket,
      originalFilename: prepared.file.name,
      contentType: prepared.mimeType,
      sizeBytes: prepared.file.size,
      extractedText: prepared.text,
      wordCount,
    });

    return NextResponse.json(
      {
        message: "Context document uploaded successfully",
        documentId: created.id,
        extractionMethod,
        extractionConfidence: prepared.confidence,
        extractionFailed,
        ...(extractionFailed
          ? { warning: "No text could be extracted from this file." }
          : {}),
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Project not found") {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    throw error;
  }
}
