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
  if (!configuredAccess || configuredAccess === "public") return "public";
  if (configuredAccess === "private") return "private";
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

export async function uploadObject(
  storageKey: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const cleanKey = sanitizeStorageKey(storageKey);

  if (isBlobEnabled()) {
    const blob = await put(cleanKey, buffer, {
      // Private storage is strongly preferred for legal documents. Keep public as the compatibility
      // default because this option must match the access mode of the provisioned Blob store.
      access: getBlobAccess(),
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType,
    });
    return blob.url;
  }

  const absolutePath = toAbsolutePath(storageKey);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer, { flag: "wx" });
  return cleanKey;
}

export async function deleteObject(storageKey: string): Promise<void> {
  // Blob writes persist the returned HTTPS URL, whereas local writes persist a relative key.
  // Select the backend from that recorded shape so an environment/config change cannot send a
  // local key to Blob or interpret a Blob URL as a local filesystem path.
  if (isRemoteObjectUrl(storageKey)) {
    await del(storageKey);
    return;
  }

  const absolutePath = toAbsolutePath(storageKey);

  await fs.rm(absolutePath, { force: true });
  await fs.rm(`${absolutePath}.meta.json`, { force: true });
}

export async function deleteObjects(
  storageKeys: readonly string[],
): Promise<void> {
  const remoteKeys = storageKeys.filter(isRemoteObjectUrl);
  const localKeys = storageKeys.filter((key) => !isRemoteObjectUrl(key));

  // Blob accepts URL arrays. Use bounded batches instead of launching one retried HTTP operation
  // per object, then remove local files sequentially to avoid an unbounded file-descriptor burst.
  const remoteBatchSize = 100;
  for (let index = 0; index < remoteKeys.length; index += remoteBatchSize) {
    await del(remoteKeys.slice(index, index + remoteBatchSize));
  }
  for (const key of localKeys) {
    await deleteObject(key);
  }
}

export function getStorageBucketName(): string {
  if (isBlobEnabled()) {
    return "vercel-blob";
  }

  return process.env.LOCAL_STORAGE_BUCKET || "local-filesystem";
}
