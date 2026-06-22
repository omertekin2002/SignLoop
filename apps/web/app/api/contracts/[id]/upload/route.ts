import { NextResponse } from 'next/server';
import { requireUserId } from "@/lib/api-auth";
import { addUploadedContractFile, getContractByIdForUser, saveContractExtractedText } from "@/lib/server-db";
import { prepareUpload, storeUploadedFile } from "@/lib/upload-pipeline";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  const contract = await getContractByIdForUser(userId, id);
  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  const prepared = await prepareUpload(req);
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: prepared.status });
  }

  if (prepared.extractionError) {
    console.error('Text extraction failed:', prepared.extractionError);
    return NextResponse.json({ error: prepared.extractionError }, { status: 500 });
  }

  if (!prepared.text || prepared.text.length === 0) {
    return NextResponse.json(
      { error: 'Could not extract any text from the file' },
      { status: 400 },
    );
  }

  try {
    const { storageKey, bucket } = await storeUploadedFile({
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
      storageKeyPrefix: `contracts/${userId}/${id}`,
      fileName: prepared.file.name,
    });

    await saveContractExtractedText({ userId, contractId: id, text: prepared.text });
    await addUploadedContractFile({
      userId,
      contractId: id,
      projectId: contract.projectId,
      title: contract.title,
      fileName: prepared.file.name,
      storageKey,
      bucket,
      contentType: prepared.mimeType,
      sizeBytes: prepared.file.size,
      extractionMethod: prepared.method,
      extractionConfidence: prepared.confidence,
    });

    return NextResponse.json({
      success: true,
      message: 'File uploaded and text extracted',
      storageKey,
      extractionMethod: prepared.method,
      confidence: prepared.confidence,
      textLength: prepared.text.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to store uploaded file";
    console.error('Upload persistence failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
