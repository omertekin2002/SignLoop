import { operationProgressResponse } from "@/lib/operation-progress-response";
import { type ReportProgress } from "@/lib/operation-progress";
import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  addContextDocumentToProject,
  listProjectContextDocumentsForUser,
  isProjectOwnedByUser,
} from "@/lib/server-db";
import {
  isDirectUploadRequest,
  parseUpload,
  prepareDirectUpload,
  prepareUpload,
  storeUploadedFile,
} from "@/lib/upload-pipeline";
import { ProjectNotFoundError } from "@/lib/errors";
import { isUuid } from "@/lib/utils";

// The parse-only function runs the parsers, but this route waits for it: image OCR budgets 60s for
// worker init plus 90s for recognition, and the platform default is well below that.
export const maxDuration = 180;

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
  if (!(await isProjectOwnedByUser(userId, id))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const data = await listProjectContextDocumentsForUser(userId, id);
  return NextResponse.json({ data, total: data.length });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return operationProgressResponse(req, (request, report) =>
    executePost(request, { params }, report),
  );
}

async function executePost(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  progress?: ReportProgress,
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

  progress?.("uploading");
  // A JSON body finalizes a file the browser already uploaded to Blob; otherwise it is multipart.
  const prepared = await (isDirectUploadRequest(req)
    ? prepareDirectUpload(req, { userId, target: { kind: "project", id } })
    : prepareUpload(req));
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.error },
      { status: prepared.status },
    );
  }

  const titleValue = prepared.fields.title;
  const documentTypeValue = prepared.fields.documentType;
  const title = titleValue?.trim() || prepared.fileName;
  const documentType = documentTypeValue?.trim() || "other";

  // Store before parsing: the parse-only function reads the file from storage. The cleanup intent
  // is recorded before the write, so a document that fails to parse is left for the outbox to
  // delete.
  let stored = prepared.stored;
  if (!stored) {
    try {
      stored = await storeUploadedFile({
        buffer: prepared.buffer,
        signal: prepared.signal,
        mimeType: prepared.mimeType,
      });
    } catch (error: unknown) {
      console.error("Context upload storage failed:", error);
      return NextResponse.json(
        { error: "Failed to store the context document. Please try again." },
        { status: 500 },
      );
    }
  }

  const extracted = await (progress
    ? parseUpload(req, prepared, stored, progress)
    : parseUpload(req, prepared, stored));
  if (!extracted.ok) {
    return NextResponse.json(
      { error: extracted.error },
      { status: extracted.status },
    );
  }

  // A context document is useful only when it can contribute text to analysis.
  if (extracted.extractionError) {
    console.error("Context text extraction failed:", extracted.extractionError);
    return NextResponse.json(
      {
        error:
          "Text could not be extracted. Verify the file is valid and try again.",
      },
      { status: 422 },
    );
  }
  if (!extracted.text.trim()) {
    return NextResponse.json(
      { error: "Could not extract any text from the context document" },
      { status: 422 },
    );
  }

  const extractionMethod = extracted.method;
  const extractionWarning = extracted.extractionWarning;

  prepared.signal.throwIfAborted();
  progress?.("saving");

  let created: { id: string };
  try {
    prepared.signal.throwIfAborted();
    const wordCount = extracted.text.split(/\s+/).filter(Boolean).length;
    created = await addContextDocumentToProject({
      userId,
      projectId: id,
      title,
      documentType,
      storageKey: stored.storageKey,
      storageIntentId: stored.storageIntentId,
      bucket: stored.bucket,
      originalFilename: prepared.fileName,
      contentType: prepared.mimeType,
      sizeBytes: prepared.buffer.length,
      extractedText: extracted.text,
      extractionWarning: extracted.extractionWarning,
      wordCount,
    });
  } catch (error: unknown) {
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
      extractionConfidence: extracted.confidence,
      extractionFailed: false,
      ...(extractionWarning ? { warning: extractionWarning } : {}),
    },
    { status: 201 },
  );
}
