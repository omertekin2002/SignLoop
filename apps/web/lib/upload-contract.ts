import { apiClient } from "@/lib/api-client";
import { isUploadResult, type OperationStage } from "@/lib/operation-progress";
import {
  assertUploadSize,
  sendUpload,
  type UploadConfig,
} from "@/lib/upload-client";

export async function uploadContract(input: {
  file: File | null;
  title: string;
  projectId?: string;
  config: UploadConfig;
  signal?: AbortSignal;
  onStage?: (stage: OperationStage) => void;
}) {
  if (!input.file) throw new Error("No file selected");
  // Fail fast on oversize files before the two-step network flow creates an orphan contract.
  assertUploadSize(input.file, input.config);
  input.signal?.throwIfAborted();
  input.onStage?.("creating");
  // Wait for the ID even if the UI closes: creation may have committed already,
  // and the cancellation check below needs that ID to remove the empty contract.
  const { data: contract } = await apiClient.post<{ id: string }>(
    "/contracts",
    { title: input.title.trim(), projectId: input.projectId },
  );
  try {
    input.signal?.throwIfAborted();
    input.onStage?.("uploading");
    return await sendUpload({
      path: `/contracts/${contract.id}/upload`,
      file: input.file,
      target: { contractId: contract.id },
      config: input.config,
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
