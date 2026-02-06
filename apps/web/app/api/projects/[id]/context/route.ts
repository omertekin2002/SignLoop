import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { addContextDocumentToProject, getProjectByIdForUser } from "@/lib/server-db";
import { getStorageBucketName, uploadObject } from "@/lib/object-storage";
import { processFile } from "@/lib/text-extraction";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const formData = await req.formData();

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  const titleValue = formData.get("title");
  const documentTypeValue = formData.get("documentType");
  const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : file.name;
  const documentType =
    typeof documentTypeValue === "string" && documentTypeValue.trim()
      ? documentTypeValue.trim()
      : "other";

  const contentType = file.type || "application/octet-stream";
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  let extractedText = "";
  let extractionMethod: string | null = null;
  let extractionConfidence: number | null = null;

  try {
    if (contentType === "text/plain") {
      extractedText = buffer.toString("utf-8");
      extractionMethod = "text";
      extractionConfidence = 100;
    } else if (contentType === "application/pdf" || contentType.startsWith("image/")) {
      const extracted = await processFile(buffer, contentType);
      extractedText = extracted.text;
      extractionMethod = extracted.method;
      extractionConfidence = typeof extracted.confidence === "number" ? extracted.confidence : null;
    } else {
      extractedText = buffer.toString("utf-8");
      extractionMethod = "best_effort_text";
      extractionConfidence = null;
    }
  } catch {
    extractedText = "";
    extractionMethod = null;
    extractionConfidence = null;
  }

  const safeFileName = file.name.replace(/[^\w.-]/g, "_");
  const storageKey = `projects/${userId}/${id}/context/${Date.now()}-${safeFileName}`;
  const bucket = getStorageBucketName();

  const storedObjectKey = await uploadObject(storageKey, buffer, contentType);

  try {
    const wordCount = extractedText.split(/\s+/).filter(Boolean).length;
    const created = await addContextDocumentToProject({
      userId,
      projectId: id,
      title,
      documentType,
      storageKey: storedObjectKey,
      bucket,
      originalFilename: file.name,
      contentType,
      sizeBytes: file.size,
      extractedText,
      wordCount,
    });

    return NextResponse.json(
      {
        message: "Context document uploaded successfully",
        documentId: created.id,
        extractionMethod,
        extractionConfidence,
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
