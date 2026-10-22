/** Versioned, opt-in progress for persisted operations. Stages describe work starting. */
export const PROGRESS_MEDIA_TYPE = "application/vnd.signloop.progress+ndjson";
export const operationStages = [
  "creating",
  "uploading",
  "extracting",
  "preparing",
  "analyzing",
  "saving",
] as const;
export type OperationStage = (typeof operationStages)[number];
export type ReportProgress = (
  stage: OperationStage,
  headers?: HeadersInit,
) => void;
export const stageLabels: Record<OperationStage, string> = {
  creating: "Creating contract…",
  uploading: "Uploading file…",
  extracting: "Extracting text…",
  preparing: "Preparing analysis…",
  analyzing: "Analyzing contract…",
  saving: "Saving…",
};
export function isOperationStage(value: unknown): value is OperationStage {
  return operationStages.some((stage) => stage === value);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export type UploadResult = { success: true; warning?: string };
export type ContextUploadResult = {
  documentId: string;
  extractionFailed: false;
  warning?: string;
};
export type AnalysisOperationResult = { analysisId: string; message?: string };
const optionalWarning = (value: Record<string, unknown>) =>
  value.warning === undefined || typeof value.warning === "string";
export const isUploadResult = (value: unknown): value is UploadResult =>
  isRecord(value) && value.success === true && optionalWarning(value);
export const isContextUploadResult = (
  value: unknown,
): value is ContextUploadResult =>
  isRecord(value) &&
  typeof value.documentId === "string" &&
  !!value.documentId &&
  value.extractionFailed === false &&
  optionalWarning(value);
export const isAnalysisOperationResult = (
  value: unknown,
): value is AnalysisOperationResult =>
  isRecord(value) &&
  typeof value.analysisId === "string" &&
  !!value.analysisId &&
  (value.message === undefined || typeof value.message === "string");
