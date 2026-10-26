import { queryOptions } from "@tanstack/react-query";
import { upload } from "@vercel/blob/client";
import { apiClient } from "@/lib/api-client";
import {
  OperationRequestError,
  postOperation,
} from "@/lib/operation-progress-client";
import type { OperationStage } from "@/lib/operation-progress";
import { MAX_MULTIPART_UPLOAD_FILE_SIZE } from "@/lib/upload-constants";

/** How the server accepts contract and project-document uploads (GET /api/uploads). */
export type UploadConfig = {
  // Set when files go from the browser straight to Vercel Blob; null for multipart uploads.
  directUpload: { access: "public" | "private" } | null;
  maxFileSizeBytes: number;
};

export const MULTIPART_UPLOAD_CONFIG: UploadConfig = {
  directUpload: null,
  maxFileSizeBytes: MAX_MULTIPART_UPLOAD_FILE_SIZE,
};

export function uploadConfigOptions() {
  return queryOptions({
    queryKey: ["upload-config"],
    staleTime: Infinity,
    queryFn: async ({ signal }) =>
      (await apiClient.get<UploadConfig>("/uploads", { signal })).data,
  });
}

export function formatUploadLimit(config: UploadConfig): string {
  return `${Math.round(config.maxFileSizeBytes / (1024 * 1024))} MB`;
}

/** Refuse an oversize file before any request, in the shape the dialogs' error toasts read. */
export function assertUploadSize(file: File, config: UploadConfig): void {
  if (file.size > config.maxFileSizeBytes)
    throw new OperationRequestError(413, {
      error: `File too large. Maximum size is ${formatUploadLimit(config)}.`,
    });
}

/**
 * Send a file to an upload route with progress. With direct uploads the bytes go to Blob first,
 * under a token issued for `target`, and the route then finalizes the blob from a JSON body;
 * otherwise the file and fields are posted as multipart.
 */
export async function sendUpload<T>(input: {
  path: string;
  file: File;
  fields?: Record<string, string>;
  target: { contractId: string } | { projectId: string };
  config: UploadConfig;
  signal?: AbortSignal;
  onStage?: (stage: OperationStage) => void;
  validate: (value: unknown) => value is T;
}): Promise<T> {
  const { path, file, fields = {}, config, signal, onStage, validate } = input;
  assertUploadSize(file, config);
  if (!config.directUpload) {
    const form = new FormData();
    form.append("file", file);
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return postOperation(path, { body: form, signal, onStage, validate });
  }

  onStage?.("uploading");
  const pathname = `uploads/${crypto.randomUUID()}`;
  try {
    await upload(pathname, file, {
      access: config.directUpload.access,
      handleUploadUrl: "/api/uploads",
      clientPayload: JSON.stringify(input.target),
      contentType: file.type || "application/octet-stream",
      abortSignal: signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    console.error("Direct upload failed:", error);
    throw new OperationRequestError(502, {
      error: "The file could not be uploaded. Please try again.",
    });
  }
  return postOperation(path, {
    body: { pathname, fileName: file.name, ...fields },
    signal,
    onStage,
    validate,
  });
}
