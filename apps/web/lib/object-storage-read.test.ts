import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: vi.fn(), get, put: vi.fn() }));

import { readObject } from "@/lib/object-storage";

const bytes = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251);
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "signloop-storage-"));
  vi.stubEnv("LOCAL_STORAGE_PATH", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const read = async (stream: ReadableStream<Uint8Array> | null) =>
  stream ? new Uint8Array(await new Response(stream).arrayBuffer()) : null;

describe("readObject", () => {
  it("streams a local object's exact bytes", async () => {
    await fs.mkdir(path.join(root, "contracts"), { recursive: true });
    await fs.writeFile(path.join(root, "contracts", "lease.pdf"), bytes);

    expect(await read(await readObject("contracts/lease.pdf"))).toEqual(bytes);
    expect(get).not.toHaveBeenCalled();
  });

  it("stays inside the storage root", async () => {
    await fs.writeFile(path.join(root, "inside.txt"), "inside");

    expect(new TextDecoder().decode((await read(await readObject("../../inside.txt")))!)).toBe("inside");
  });

  it("returns null for a missing local object", async () => {
    expect(await readObject("contracts/gone.pdf")).toBeNull();
  });

  it("streams a Blob URL with the configured access, bypassing the cache", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    get.mockResolvedValue({ statusCode: 200, stream: new Response(bytes).body });
    const url = "https://store.private.blob.vercel-storage.com/contracts/lease.pdf";

    expect(await read(await readObject(url))).toEqual(bytes);
    expect(get).toHaveBeenCalledWith(url, {
      access: "private",
      useCache: false,
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("returns null for a Blob that no longer exists", async () => {
    get.mockResolvedValue(null);
    expect(await readObject("https://store.private.blob.vercel-storage.com/gone.pdf")).toBeNull();
  });

  it("does not start after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("download cancelled"));
    await expect(readObject("contracts/lease.pdf", controller.signal)).rejects.toThrow("download cancelled");
  });
});
