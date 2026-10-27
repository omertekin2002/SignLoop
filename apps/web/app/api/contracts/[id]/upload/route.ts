import { operationProgressResponse } from "@/lib/operation-progress-response";
import { type ReportProgress } from "@/lib/operation-progress";
import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  getContractMetaForUser,
  saveContractUploadForUser,
} from "@/lib/server-db";
import {
  isDirectUploadRequest,
  parseUpload,
  prepareDirectUpload,
  prepareUpload,
  storeUploadedFile,
} from "@/lib/upload-pipeline";
import { isUuid } from "@/lib/utils";

// The parse-only function runs the parsers, but this route waits for it: image OCR budgets 60s for
// worker init plus 90s for recognition, and the platform default is well below that.
export const maxDuration = 180;

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
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  const contract = await getContractMetaForUser(userId, id);
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  progress?.("uploading");
  // A JSON body finalizes a file the browser already uploaded to Blob; otherwise it is multipart.
  const prepared = await (isDirectUploadRequest(req)
    ? prepareDirectUpload(req, { userId, target: { kind: "contract", id } })
    : prepareUpload(req));
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.error },
      { status: prepared.status },
    );
  }

  // Store before parsing: the parse-only function reads the file from storage. The cleanup intent
  // is recorded before the write, so a file that fails to parse is left for the outbox to delete.
  let stored = prepared.stored;
  if (!stored) {
    try {
      stored = await storeUploadedFile({
        buffer: prepared.buffer,
        signal: prepared.signal,
        mimeType: prepared.mimeType,
      });
    } catch (error: unknown) {
      console.error("Upload storage failed:", error);
      return NextResponse.json(
        { error: "Failed to store the uploaded file. Please try again." },
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

  if (extracted.extractionError) {
    console.error("Text extraction failed:", extracted.extractionError);
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
      { error: "Could not extract any text from the file" },
      { status: 400 },
    );
  }

  prepared.signal.throwIfAborted();
  progress?.("saving");

  try {
    prepared.signal.throwIfAborted();
    const saved = await saveContractUploadForUser({
      userId,
      contractId: id,
      text: extracted.text,
      extractionWarning: extracted.extractionWarning,
      projectId: contract.projectId,
      title: contract.title,
      fileName: prepared.fileName,
      storageKey: stored.storageKey,
      storageIntentId: stored.storageIntentId,
      bucket: stored.bucket,
      contentType: prepared.mimeType,
      sizeBytes: prepared.buffer.length,
      extractionMethod: extracted.method,
      extractionConfidence: extracted.confidence,
    });
    if (!saved) {
      return NextResponse.json(
        { error: "Contract not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "File uploaded and text extracted",
      extractionMethod: extracted.method,
      confidence: extracted.confidence,
      textLength: extracted.text.length,
      ...(extracted.extractionWarning
        ? { warning: extracted.extractionWarning }
        : {}),
    });
  } catch (error: unknown) {
    console.error("Upload persistence failed:", error);
    return NextResponse.json(
      { error: "Failed to save the uploaded file. Please try again." },
      { status: 500 },
    );
  }
}
