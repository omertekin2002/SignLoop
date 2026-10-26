// Shared upload limits used by both the server pipeline (lib/upload-pipeline.ts) and the client
// upload UIs (upload-dialog, project page). Kept dependency-free so client components can import
// it without pulling in the server-only extraction/storage modules.

// Multipart uploads go through a function, so they must leave room for multipart framing beneath
// Vercel's 4.5 MB request limit. Local storage and chat attachments always use this path.
export const MAX_MULTIPART_UPLOAD_FILE_SIZE_MB = 4;
export const MAX_MULTIPART_UPLOAD_FILE_SIZE =
  MAX_MULTIPART_UPLOAD_FILE_SIZE_MB * 1024 * 1024;

// Contracts and project documents go from the browser straight to Vercel Blob when it is
// configured, which the function request limit does not cap.
export const MAX_DIRECT_UPLOAD_FILE_SIZE_MB = 10;
export const MAX_DIRECT_UPLOAD_FILE_SIZE =
  MAX_DIRECT_UPLOAD_FILE_SIZE_MB * 1024 * 1024;

// The only Blob pathname a client may upload to: opaque, like storeUploadedFile's keys, with no
// owner ID, entity ID, or filename.
export const DIRECT_UPLOAD_PATHNAME =
  /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
