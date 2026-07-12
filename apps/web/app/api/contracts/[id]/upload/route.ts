import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  getContractMetaForUser,
  saveContractUploadForUser,
} from "@/lib/server-db";
import { prepareUpload, storeUploadedFile } from "@/lib/upload-pipeline";
import { deleteObject } from "@/lib/object-storage";
import { isUuid } from "@/lib/utils";

async function cleanupNewUpload(storageKey: string): Promise<void> {
  try {
    await deleteObject(storageKey);
  } catch (cleanupError: unknown) {
    console.error(
      "Failed to clean up upload after persistence error:",
      cleanupError,
    );
  }
}

export async function POST(
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
  const contract = await getContractMetaForUser(userId, id);
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const prepared = await prepareUpload(req);
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

  if (!prepared.text || prepared.text.length === 0) {
    return NextResponse.json(
      { error: "Could not extract any text from the file" },
      { status: 400 },
    );
  }

  let stored: { storageKey: string; bucket: string };
  try {
    stored = await storeUploadedFile({
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
    });
  } catch (error: unknown) {
    console.error("Upload storage failed:", error);
    return NextResponse.json(
      { error: "Failed to store the uploaded file. Please try again." },
      { status: 500 },
    );
  }

  try {
    const saved = await saveContractUploadForUser({
      userId,
      contractId: id,
      text: prepared.text,
      projectId: contract.projectId,
      title: contract.title,
      fileName: prepared.file.name,
      storageKey: stored.storageKey,
      bucket: stored.bucket,
      contentType: prepared.mimeType,
      sizeBytes: prepared.file.size,
      extractionMethod: prepared.method,
      extractionConfidence: prepared.confidence,
    });
    if (!saved) {
      await cleanupNewUpload(stored.storageKey);
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
    await cleanupNewUpload(stored.storageKey);
    console.error("Upload persistence failed:", error);
    return NextResponse.json(
      { error: "Failed to save the uploaded file. Please try again." },
      { status: 500 },
    );
  }
}
