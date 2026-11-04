import { CHAT_FILE_TYPES } from "@/lib/chat-files-shared";

const CLIPBOARD_EXTENSIONS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(CHAT_FILE_TYPES).map(([extension, type]) => [
      type,
      extension,
    ]),
  ),
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Read file bytes supplied by a paste event; never fetch clipboard text, URLs, or local paths. */
export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  // Some browsers populate only items. Prefer files when present to avoid attaching each twice.
  const files = Array.from(data.files ?? []);
  if (!files.length) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files.map((file, index) => {
    const extension = CLIPBOARD_EXTENSIONS[file.type.toLowerCase()];
    // Clipboard blobs can have no filename (or just "image"). Give those a supported extension;
    // named files still pass through the usual upload validation unchanged.
    if (!extension || /\.[^./\\]+$/.test(file.name)) return file;
    return new File(
      [file],
      `${file.name || `pasted-file-${index + 1}`}.${extension}`,
      {
        type: file.type,
        lastModified: file.lastModified,
      },
    );
  });
}

/** Stage pasted files just like paperclip selections, leaving text paste to the browser. */
export function pasteChatFiles(
  event: Pick<ClipboardEvent, "clipboardData" | "preventDefault">,
  addAttachment: (file: File) => Promise<unknown>,
  enabled: boolean,
): void {
  if (!enabled) return;
  const files = clipboardFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  // The attachment adapter reports validation errors. Settle each file independently so one
  // rejected item neither hides other attachments nor causes an unhandled promise rejection.
  void Promise.allSettled(files.map(async (file) => addAttachment(file)));
}
