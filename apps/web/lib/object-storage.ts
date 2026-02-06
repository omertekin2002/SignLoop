import fs from "node:fs/promises";
import path from "node:path";
import { del, put } from "@vercel/blob";

type UploadMetadata = {
  contentType: string;
  uploadedAt: string;
};

function getDefaultStorageRoot(): string {
  const cwd = process.cwd();
  const normalized = cwd.replace(/\\/g, "/");

  if (normalized.endsWith("/apps/web")) {
    return path.join(cwd, "uploads");
  }

  return path.join(cwd, "apps", "web", "uploads");
}

function getStorageRoot(): string {
  return process.env.LOCAL_STORAGE_PATH || getDefaultStorageRoot();
}

function isBlobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function sanitizeStorageKey(storageKey: string): string {
  const normalized = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function toAbsolutePath(storageKey: string): string {
  const cleanKey = sanitizeStorageKey(storageKey);
  return path.join(getStorageRoot(), cleanKey);
}

export async function uploadObject(
  storageKey: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const cleanKey = sanitizeStorageKey(storageKey);

  if (isBlobEnabled()) {
    const blob = await put(cleanKey, buffer, {
      access: "public",
      addRandomSuffix: false,
      contentType,
    });
    return blob.url;
  }

  const absolutePath = toAbsolutePath(storageKey);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);

  const metadata: UploadMetadata = {
    contentType,
    uploadedAt: new Date().toISOString(),
  };

  await fs.writeFile(`${absolutePath}.meta.json`, JSON.stringify(metadata));
  return cleanKey;
}

export async function deleteObject(storageKey: string): Promise<void> {
  if (isBlobEnabled()) {
    await del(storageKey);
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
