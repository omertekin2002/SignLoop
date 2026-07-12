import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareUpload, storeUploadedFile } from "./upload-pipeline";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("prepareUpload", () => {
  it("rejects zero-byte files", async () => {
    const formData = new FormData();
    formData.set(
      "file",
      new File([], "empty.pdf", { type: "application/pdf" }),
    );

    const result = await prepareUpload(
      new Request("http://localhost/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/empty/i),
    });
  });

  it("rejects file contents that do not match the declared type before extraction", async () => {
    const formData = new FormData();
    formData.set(
      "file",
      new File([Buffer.from("not a real PDF")], "contract.pdf", {
        type: "application/pdf",
      }),
    );

    const result = await prepareUpload(
      new Request("http://localhost/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/contents do not match/i),
    });
  });
});

describe("storeUploadedFile", () => {
  it("uses unique opaque object keys", async () => {
    const storageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "signloop-upload-"),
    );
    temporaryDirectories.push(storageRoot);
    vi.stubEnv("LOCAL_STORAGE_PATH", storageRoot);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    const first = await storeUploadedFile({
      buffer: Buffer.from("first"),
      mimeType: "text/plain",
    });
    const second = await storeUploadedFile({
      buffer: Buffer.from("second"),
      mimeType: "text/plain",
    });

    expect(first.storageKey).toMatch(
      /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second.storageKey).not.toBe(first.storageKey);
    await expect(
      fs.readFile(path.join(storageRoot, first.storageKey), "utf8"),
    ).resolves.toBe("first");
  });
});
