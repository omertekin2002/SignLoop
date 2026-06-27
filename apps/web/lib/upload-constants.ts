// Shared upload limits used by both the server pipeline (lib/upload-pipeline.ts) and the client
// upload UIs (upload-dialog, project page). Kept dependency-free so client components can import
// it without pulling in the server-only extraction/storage modules.
export const MAX_UPLOAD_FILE_SIZE_MB = 20;
export const MAX_UPLOAD_FILE_SIZE = MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024;
