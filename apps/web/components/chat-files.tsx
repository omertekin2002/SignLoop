"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AttachmentPrimitive,
  useAttachment,
  useMessage,
} from "@assistant-ui/react";
import { Download, FileText, X } from "lucide-react";
import {
  parseChatDownloads,
  type ChatDownloadFile,
} from "@/lib/chat-files-shared";
import { Button } from "@/components/ui/button";

function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return blob ? url : undefined;
}

export function ComposerFile() {
  return (
    <AttachmentPrimitive.Root className="flex max-w-full items-center gap-2 rounded-button border border-input px-3 py-1 text-sm">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">
        <AttachmentPrimitive.Name />
      </span>
      <AttachmentPrimitive.Remove asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          aria-label="Remove file"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

export function UploadedFile() {
  const attachment = useAttachment();
  const localUrl = useBlobUrl(attachment.file);
  const remoteUrl = attachment.content?.find((part) => part.type === "text");
  const savedUrl =
    remoteUrl?.type === "text" &&
    /^\/api\/chat\/threads\/[\da-f-]{36}\/files\/[\da-f-]{36}$/i.test(
      remoteUrl.text,
    )
      ? remoteUrl.text
      : undefined;
  return (
    <AttachmentPrimitive.Root className="flex max-w-full items-center gap-2 text-sm">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      {localUrl || savedUrl ? (
        <a
          href={savedUrl ?? localUrl}
          download={attachment.name}
          className="truncate text-foreground underline underline-offset-4"
        >
          {attachment.name}
        </a>
      ) : (
        <span className="truncate">
          <AttachmentPrimitive.Name />
        </span>
      )}
    </AttachmentPrimitive.Root>
  );
}

function FileDownload({ file }: { file: ChatDownloadFile }) {
  const blob = useMemo(() => {
    if (!file.data) return undefined;
    const binary = atob(file.data);
    return new Blob(
      [Uint8Array.from(binary, (character) => character.charCodeAt(0))],
      { type: file.mediaType },
    );
  }, [file.data, file.mediaType]);
  const localUrl = useBlobUrl(blob);
  const url = file.url ?? localUrl;
  if (!url) return null;
  return (
    <a
      href={url}
      download={file.name}
      className="flex max-w-full items-center gap-3 rounded-card border border-input px-4 py-3 text-sm text-foreground hover:bg-secondary"
    >
      <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{file.name}</span>
        <span className="text-caption text-muted-foreground">
          {Math.max(1, Math.ceil(file.size / 1024))} KB
        </span>
      </span>
      <Download className="h-4 w-4 shrink-0" />
      <span className="sr-only">Download {file.name}</span>
    </a>
  );
}

export function MessageFileDownloads() {
  const value = useMessage((message) => message.metadata.custom?.files);
  const files = useMemo(() => parseChatDownloads(value), [value]);
  if (!files.length) return null;
  return (
    <div className="my-2 flex max-w-lg flex-col gap-2">
      {files.map((file) => (
        <FileDownload key={file.id} file={file} />
      ))}
    </div>
  );
}
