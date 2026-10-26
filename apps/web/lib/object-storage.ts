import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { BlobNotFoundError, del, get, head, put } from "@vercel/blob";

function getDefaultStorageRoot(): string {
  // Workspace scripts execute with apps/web as their cwd. Keeping the dynamic portion scoped to
  // one static child directory also prevents Next's file tracer from including the whole repo.
  return path.join(/* turbopackIgnore: true */ process.cwd(), "uploads");
}

function getStorageRoot(): string {
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.LOCAL_STORAGE_PATH
  ) {
    throw new Error(
      "Object storage is not configured. Set BLOB_READ_WRITE_TOKEN or an explicit persistent LOCAL_STORAGE_PATH.",
    );
  }

  return process.env.LOCAL_STORAGE_PATH || getDefaultStorageRoot();
}

function isBlobEnabled(): boolean {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID,
  );
}

/**
 * Browsers can upload straight to Blob only with client tokens, which are signed with a
 * read-write token; store-ID (OIDC) setups keep the multipart path.
 */
export function isDirectUploadAvailable(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function getBlobAccess(): "public" | "private" {
  const configuredAccess = process.env.BLOB_ACCESS?.trim().toLowerCase();
  if (configuredAccess === "public") return "public";
  if (!configuredAccess || configuredAccess === "private") return "private";
  throw new Error('BLOB_ACCESS must be either "public" or "private"');
}

function sanitizeStorageKey(storageKey: string): string {
  const normalized = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
  const cleanKey = normalized
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");

  if (!cleanKey) {
    throw new Error("Storage key cannot be empty");
  }

  return cleanKey;
}

function isRemoteObjectUrl(storageKey: string): boolean {
  return /^https:\/\//i.test(storageKey.trim());
}

function toAbsolutePath(storageKey: string): string {
  const cleanKey = sanitizeStorageKey(storageKey);
  return path.join(/* turbopackIgnore: true */ getStorageRoot(), cleanKey);
}

/** Record the actual backend, independently of the configurable local bucket label. */
export function getUploadCleanupKey(storageKey: string): string {
  return isBlobEnabled()
    ? `blob:${sanitizeStorageKey(storageKey)}`
    : sanitizeStorageKey(storageKey);
}

export async function uploadObject(
  storageKey: string,
  buffer: Buffer,
  contentType: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const cleanKey = sanitizeStorageKey(storageKey);

  if (isBlobEnabled()) {
    const blob = await put(cleanKey, buffer, {
      // Existing public stores must opt in explicitly with BLOB_ACCESS=public.
      access: getBlobAccess(),
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType,
      abortSignal: AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(signal ? [signal] : []),
      ]),
    });
    return blob.url;
  }

  const absolutePath = toAbsolutePath(storageKey);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer, { flag: "wx", signal });
  return cleanKey;
}

export async function deleteObject(
  storageKey: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const deleteSignal = () => AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(signal ? [signal] : []),
  ]);
  // Pre-write cleanup intents know the deterministic Blob pathname before put returns its URL.
  if (storageKey.startsWith("blob:")) {
    await del(storageKey.slice(5), {
      abortSignal: deleteSignal(),
    });
    return;
  }
  // Blob writes persist the returned HTTPS URL, whereas local writes persist a relative key.
  // Select the backend from that recorded shape so an environment/config change cannot send a
  // local key to Blob or interpret a Blob URL as a local filesystem path.
  if (isRemoteObjectUrl(storageKey)) {
    await del(storageKey, { abortSignal: deleteSignal() });
    return;
  }

  const absolutePath = toAbsolutePath(storageKey);

  await fs.rm(absolutePath, { force: true });
  // fs.rm has no AbortSignal support; avoid starting another operation after expiry.
  signal?.throwIfAborted();
  await fs.rm(`${absolutePath}.meta.json`, { force: true });
}

/**
 * Stream a stored object's bytes, or return null when it no longer exists. Like deleteObject, the
 * backend follows the recorded key's shape: an HTTPS URL is a Blob, anything else a local key.
 */
export async function readObject(
  storageKey: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array> | null> {
  signal?.throwIfAborted();
  if (isRemoteObjectUrl(storageKey)) {
    const result = await get(storageKey.trim(), {
      access: getBlobAccess(),
      useCache: false,
      abortSignal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(signal ? [signal] : []),
      ]),
    });
    return result?.statusCode === 200 ? result.stream : null;
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(toAbsolutePath(storageKey), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return Readable.toWeb(
    handle.createReadStream({ signal }),
  ) as ReadableStream<Uint8Array>;
}

/** Whether a Blob pathname is already taken. Errors other than "not found" propagate. */
export async function blobExists(
  pathname: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await head(sanitizeStorageKey(pathname), {
      abortSignal: AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : []),
      ]),
    });
    return true;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return false;
    throw error;
  }
}

export type UploadedBlob =
  | { ok: true; url: string; contentType: string; buffer: Buffer }
  | { ok: false; reason: "missing" | "too_large" };

/**
 * Read back a blob the browser uploaded, stopping past maxBytes whatever size Blob reports, so a
 * finalize request never buffers more than the upload limit.
 */
export async function readUploadedBlob(
  pathname: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<UploadedBlob> {
  signal?.throwIfAborted();
  const result = await get(sanitizeStorageKey(pathname), {
    access: getBlobAccess(),
    useCache: false,
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (result?.statusCode !== 200) return { ok: false, reason: "missing" };
  const reader = result.stream.getReader();
  try {
    if (result.blob.size > maxBytes) return { ok: false, reason: "too_large" };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return { ok: false, reason: "too_large" };
      chunks.push(value);
    }
    return {
      ok: true,
      url: result.blob.url,
      contentType: result.blob.contentType,
      buffer: Buffer.concat(chunks, bytes),
    };
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function getStorageBucketName(): string {
  if (isBlobEnabled()) {
    return "vercel-blob";
  }

  return process.env.LOCAL_STORAGE_BUCKET || "local-filesystem";
}
