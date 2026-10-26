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
  prepareDirectUpload,
  prepareUpload,
  storeUploadedFile,
} from "@/lib/upload-pipeline";
import { isUuid } from "@/lib/utils";

// Image uploads run OCR, which budgets 60s for worker init plus 90s for recognition. The platform
// default is well below that, so a scanned upload would be killed after the work was already done.
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
    ? prepareDirectUpload(
        req,
        { userId, target: { kind: "contract", id } },
        progress,
      )
    : progress
      ? prepareUpload(req, progress)
      : prepareUpload(req));
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.error },
      { status: prepared.status },
    );
  }

  if (prepared.extractionError) {
    console.error("Text extraction failed:", prepared.extractionError);
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
      { error: "Could not extract any text from the file" },
      { status: 400 },
    );
  }

  prepared.signal.throwIfAborted();
  progress?.("saving");
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

  try {
    prepared.signal.throwIfAborted();
    const saved = await saveContractUploadForUser({
      userId,
      contractId: id,
      text: prepared.text,
      extractionWarning: prepared.extractionWarning,
      projectId: contract.projectId,
      title: contract.title,
      fileName: prepared.fileName,
      storageKey: stored.storageKey,
      storageIntentId: stored.storageIntentId,
      bucket: stored.bucket,
      contentType: prepared.mimeType,
      sizeBytes: prepared.buffer.length,
      extractionMethod: prepared.method,
      extractionConfidence: prepared.confidence,
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
      extractionMethod: prepared.method,
      confidence: prepared.confidence,
      textLength: prepared.text.length,
      ...(prepared.extractionWarning
        ? { warning: prepared.extractionWarning }
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
