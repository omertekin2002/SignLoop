import { NextResponse } from 'next/server';
import { auth } from "@clerk/nextjs/server";
import { addUploadedContractFile, getContractByIdForUser, saveContractExtractedText } from "@/lib/server-db";
import { processFile, validateMimeType } from '@/lib/text-extraction';
import { getStorageBucketName, uploadObject } from "@/lib/object-storage";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const contract = await getContractByIdForUser(userId, id);
  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  // Handle FormData
  const formData = await req.formData();
  const file = formData.get('file') as File;

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: 'File too large. Maximum size is 20 MB.' },
      { status: 413 },
    );
  }

  const rawMimeType = file.type || 'application/octet-stream';
  let mimeType: string;

  // Validate file type
  try {
    mimeType = validateMimeType(rawMimeType, file.name);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid file type";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract text from file
    const { text, method, confidence } = await processFile(buffer, mimeType, file.name);

    if (!text || text.length === 0) {
      return NextResponse.json(
        { error: 'Could not extract any text from the file' },
        { status: 400 }
      );
    }

    const safeFileName = file.name.replace(/[^\w.-]/g, "_");
    const storageKey = `contracts/${userId}/${id}/${Date.now()}-${safeFileName}`;
    const bucket = getStorageBucketName();

    const storedObjectKey = await uploadObject(storageKey, buffer, mimeType);
    await saveContractExtractedText({
      userId,
      contractId: id,
      text,
    });
    await addUploadedContractFile({
      userId,
      contractId: id,
      projectId: contract.projectId,
      title: contract.title,
      fileName: file.name,
      storageKey: storedObjectKey,
      bucket,
      contentType: mimeType,
      sizeBytes: file.size,
      extractionMethod: method,
      extractionConfidence: typeof confidence === "number" ? confidence : null,
    });

    return NextResponse.json({
      success: true,
      message: 'File uploaded and text extracted',
      storageKey: storedObjectKey,
      extractionMethod: method,
      confidence,
      textLength: text.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to extract text from file";
    console.error('Text extraction failed:', error);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
