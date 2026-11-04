"use client";

import { MAX_CHAT_IMAGE_BYTES } from "@/lib/chat-files-shared";

/** Keep small images byte-for-byte; shrink larger images before upload and inline replay. */
export async function prepareChatImage(file: File): Promise<File> {
  if (file.size <= MAX_CHAT_IMAGE_BYTES) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare this image for chat.");
    for (let attempt = 0; attempt < 6; attempt++) {
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      if (blob && blob.size <= MAX_CHAT_IMAGE_BYTES)
        return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
          type: "image/jpeg",
        });
      canvas.width = Math.max(1, Math.floor(canvas.width * 0.75));
      canvas.height = Math.max(1, Math.floor(canvas.height * 0.75));
    }
    throw new Error("Could not shrink this image. Try a smaller image.");
  } finally {
    bitmap.close();
  }
}
