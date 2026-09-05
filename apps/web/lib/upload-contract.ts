import { apiClient } from "@/lib/api-client";
import { MAX_UPLOAD_FILE_SIZE, MAX_UPLOAD_FILE_SIZE_MB } from "@/lib/upload-constants";

export async function uploadContract(input: { file: File | null; title: string; projectId?: string }) {
  if (!input.file) throw new Error("No file selected");
  if (input.file.size > MAX_UPLOAD_FILE_SIZE) throw new Error(`File too large. Maximum size is ${MAX_UPLOAD_FILE_SIZE_MB} MB.`);
  const { data: contract } = await apiClient.post<{ id: string }>("/contracts", { title: input.title.trim(), projectId: input.projectId });
  try {
    const form = new FormData();
    form.append("file", input.file);
    return (await apiClient.post<{ warning?: string }>(`/contracts/${contract.id}/upload`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    })).data;
  } catch (error) {
    await apiClient.delete(`/contracts/${contract.id}`).catch(() => {});
    throw error;
  }
}
