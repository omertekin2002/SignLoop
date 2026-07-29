import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  addContextDocumentToProject,
  getProjectByIdForUser,
  isProjectOwnedByUser,
} from "@/lib/server-db";
import { prepareUpload, storeUploadedFile } from "@/lib/upload-pipeline";
import { deleteObject } from "@/lib/object-storage";
import { ProjectNotFoundError } from "@/lib/errors";
import { isUuid } from "@/lib/utils";

async function cleanupNewUpload(storageKey: string): Promise<void> {
  try {
    await deleteObject(storageKey);
  } catch (cleanupError: unknown) {
    console.error(
      "Failed to clean up context upload after persistence error:",
      cleanupError,
    );
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = await getProjectByIdForUser(userId, id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({
    data: project.contextDocuments,
    total: project.contextDocuments.length,
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;

  // Verify the project exists and is owned BEFORE storing the blob. Previously storeUploadedFile()
  // ran first and ownership was only checked inside the DB insert, so a POST to a non-owned/unknown
  // project persisted the bytes and then 404'd — leaking an unreachable, never-cleaned-up object.
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  // Only the ownership boolean matters here, so use the single-row probe rather than loading the
  // full project graph (contracts + context documents + analyses) and discarding all of it.
  if (!(await isProjectOwnedByUser(userId, id))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const prepared = await prepareUpload(req);
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.error },
      { status: prepared.status },
    );
  }

  const titleValue = prepared.formData.get("title");
  const documentTypeValue = prepared.formData.get("documentType");
  const title =
    typeof titleValue === "string" && titleValue.trim()
      ? titleValue.trim()
      : prepared.file.name;
  const documentType =
    typeof documentTypeValue === "string" && documentTypeValue.trim()
      ? documentTypeValue.trim()
      : "other";

  // A context document is useful only when it can contribute text to analysis. Reject failed
  // extraction before storage rather than retaining an unusable public object.
  if (prepared.extractionError) {
    console.error("Context text extraction failed:", prepared.extractionError);
    return NextResponse.json(
      {
        error:
          "Text could not be extracted. Verify the file is valid and try again.",
      },
      { status: 422 },
    );
  }
  if (!prepared.text.trim()) {
    return NextResponse.json(
      { error: "Could not extract any text from the context document" },
      { status: 422 },
    );
  }

  const extractionMethod = prepared.method;
  const extractionWarning = prepared.extractionWarning;

  let stored: { storageKey: string; bucket: string };
  try {
    stored = await storeUploadedFile({
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
    });
  } catch (error: unknown) {
    console.error("Context upload storage failed:", error);
    return NextResponse.json(
      { error: "Failed to store the context document. Please try again." },
      { status: 500 },
    );
  }

  let created: { id: string };
  try {
    const wordCount = prepared.text.split(/\s+/).filter(Boolean).length;
    created = await addContextDocumentToProject({
      userId,
      projectId: id,
      title,
      documentType,
      storageKey: stored.storageKey,
      bucket: stored.bucket,
      originalFilename: prepared.file.name,
      contentType: prepared.mimeType,
      sizeBytes: prepared.file.size,
      extractedText: prepared.text,
      wordCount,
    });
  } catch (error: unknown) {
    await cleanupNewUpload(stored.storageKey);
    if (error instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    console.error("Context upload persistence failed:", error);
    return NextResponse.json(
      { error: "Failed to save the context document. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      message: "Context document uploaded successfully",
      documentId: created.id,
      extractionMethod,
      extractionConfidence: prepared.confidence,
      extractionFailed: false,
      ...(extractionWarning ? { warning: extractionWarning } : {}),
    },
    { status: 201 },
  );
}
