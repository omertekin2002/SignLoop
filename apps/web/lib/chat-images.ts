import { imageSize } from "image-size";
import { validateFileSignature } from "@/lib/file-types";
import { MAX_CHAT_IMAGE_BYTES, type ChatImage } from "@/lib/chat-files-shared";

/** Inspect image headers without OCR or pixel decoding. No URLs or SVG are accepted. */
export function validateChatImage(buffer: Buffer, mediaType: string): void {
  if (!buffer.length || buffer.length > MAX_CHAT_IMAGE_BYTES)
    throw new Error("Image is too large. Reattach it to optimize it for chat.");
  validateFileSignature(buffer, mediaType);
  const { width, height } = imageSize(buffer);
  if (!width || !height || width * height > 25_000_000)
    throw new Error("Image dimensions exceed the 25 megapixel limit.");
}

/** Temporary images arrive as bounded inline bytes; validate them just like saved uploads. */
export function validateInlineChatImage(image: ChatImage): void {
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length !== image.size || bytes.toString("base64") !== image.data)
    throw new Error("Invalid image data.");
  validateChatImage(bytes, image.mediaType);
}
