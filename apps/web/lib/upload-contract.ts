import { apiClient } from "@/lib/api-client";
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILE_SIZE_MB,
} from "@/lib/upload-constants";
import { isUploadResult, type OperationStage } from "@/lib/operation-progress";
import { postOperation } from "@/lib/operation-progress-client";

export async function uploadContract(input: {
  file: File | null;
  title: string;
  projectId?: string;
  signal?: AbortSignal;
  onStage?: (stage: OperationStage) => void;
}) {
  if (!input.file) throw new Error("No file selected");
  if (input.file.size > MAX_UPLOAD_FILE_SIZE)
    throw new Error(
      `File too large. Maximum size is ${MAX_UPLOAD_FILE_SIZE_MB} MB.`,
    );
  input.signal?.throwIfAborted();
  input.onStage?.("creating");
  const { data: contract } = await apiClient.post<{ id: string }>(
    "/contracts",
    { title: input.title.trim(), projectId: input.projectId },
    { signal: input.signal },
  );
  try {
    input.signal?.throwIfAborted();
    const form = new FormData();
    form.append("file", input.file);
    input.onStage?.("uploading");
    return await postOperation(`/contracts/${contract.id}/upload`, {
      body: form,
      signal: input.signal,
      onStage: input.onStage,
      validate: isUploadResult,
    });
  } catch (error) {
    // Cleanup must still run when the operation's signal has been canceled.
    await apiClient.delete(`/contracts/${contract.id}`).catch(() => {});
    throw error;
  }
}
