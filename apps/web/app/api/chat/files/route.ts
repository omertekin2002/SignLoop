import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { prepareUpload } from "@/lib/upload-pipeline";
import {
  CHAT_FILE_TYPES,
  chatFileName,
  MAX_CHAT_FILE_TEXT,
  type ChatDocument,
} from "@/lib/chat-files-shared";
import { isChatThreadOwnedByUser, saveChatFileForUser } from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

export const maxDuration = 180;

export async function POST(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const threadId = new URL(req.url).searchParams.get("threadId");
  if (
    threadId &&
    (!isUuid(threadId) ||
      !(await isChatThreadOwnedByUser(authed.userId, threadId)))
  )
    return NextResponse.json(
      { error: "Chat thread not found." },
      { status: 404 },
    );
  try {
    const upload = await prepareUpload(req, undefined, {
      allowedExtensions: ["pdf", "txt", "docx"],
      allowedMimeTypes: Object.values(CHAT_FILE_TYPES),
    });
    if (!upload.ok)
      return NextResponse.json(
        { error: upload.error },
        { status: upload.status },
      );
    if (
      !Object.values(CHAT_FILE_TYPES).includes(
        upload.mimeType as (typeof CHAT_FILE_TYPES)[keyof typeof CHAT_FILE_TYPES],
      )
    )
      return NextResponse.json(
        { error: "Attach a PDF, TXT, or DOCX file." },
        { status: 400 },
      );
    if (upload.extractionError || !upload.text.trim())
      return NextResponse.json(
        {
          error:
            "No readable text was found. For scanned PDFs, attach a version with a text layer.",
        },
        { status: 422 },
      );
    if (upload.text.length > MAX_CHAT_FILE_TEXT)
      return NextResponse.json(
        {
          error:
            "This document exceeds the 200,000 character chat limit. Split it into smaller files.",
        },
        { status: 413 },
      );
    upload.signal.throwIfAborted();
    const document: ChatDocument = {
      id: randomUUID(),
      name: chatFileName(upload.file.name),
      mediaType: upload.mimeType,
      size: upload.buffer.length,
      text: upload.text,
      ...(upload.extractionWarning
        ? { warning: upload.extractionWarning }
        : {}),
    };
    if (!threadId)
      return NextResponse.json(
        { file: document },
        { headers: { "Cache-Control": "no-store" } },
      );
    const file = await saveChatFileForUser({
      userId: authed.userId,
      threadId,
      file: document,
      data: upload.buffer,
    });
    if (!file)
      return NextResponse.json(
        { error: "Chat thread not found." },
        { status: 404 },
      );
    return NextResponse.json(
      { file },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Chat file upload failed:", error);
    return NextResponse.json(
      {
        error:
          "File upload failed. Please try again or start a new chat if its file limit was reached.",
      },
      { status: 503 },
    );
  }
}
