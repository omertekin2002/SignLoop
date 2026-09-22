import fs from "node:fs/promises";
import path from "node:path";
import { del, put } from "@vercel/blob";

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

function getBlobAccess(): "public" | "private" {
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

export async function deleteObject(storageKey: string): Promise<void> {
  // Pre-write cleanup intents know the deterministic Blob pathname before put returns its URL.
  if (storageKey.startsWith("blob:")) {
    await del(storageKey.slice(5), {
      abortSignal: AbortSignal.timeout(30_000),
    });
    return;
  }
  // Blob writes persist the returned HTTPS URL, whereas local writes persist a relative key.
  // Select the backend from that recorded shape so an environment/config change cannot send a
  // local key to Blob or interpret a Blob URL as a local filesystem path.
  if (isRemoteObjectUrl(storageKey)) {
    await del(storageKey, { abortSignal: AbortSignal.timeout(30_000) });
    return;
  }

  const absolutePath = toAbsolutePath(storageKey);

  await fs.rm(absolutePath, { force: true });
  await fs.rm(`${absolutePath}.meta.json`, { force: true });
}

export function getStorageBucketName(): string {
  if (isBlobEnabled()) {
    return "vercel-blob";
  }

  return process.env.LOCAL_STORAGE_BUCKET || "local-filesystem";
}
