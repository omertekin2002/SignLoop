import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getExtractionWarning,
  prepareUpload,
  storeUploadedFile,
} from "./upload-pipeline";

vi.mock("@/lib/server-db", () => ({
  createUploadCleanupIntent: vi.fn().mockResolvedValue("intent"),
}));

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

  it("warns about the scanned page of a real mixed PDF and keeps the readable text", async () => {
    const pdf = await fs.readFile(
      new URL("./fixtures/pdf-scanned-middle-page.pdf", import.meta.url),
    );
    const formData = new FormData();
    formData.set(
      "file",
      new File([pdf], "agreement.pdf", { type: "application/pdf" }),
    );

    const result = await prepareUpload(
      new Request("http://localhost/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      method: "pdf_parse",
      confidence: 66,
      extractionError: null,
      extractionWarning:
        "Page 2 has little or no selectable text and was not read; it may be a scanned image. Verify that page in the original before relying on the analysis.",
    });
    if (!result.ok) throw new Error("expected a prepared upload");
    expect(result.text).toContain("MASTER SERVICES AGREEMENT");
    expect(result.text).toContain("sixty days written notice.");
  });
});

describe("getExtractionWarning", () => {
  const digital = { method: "pdf_parse" as const, confidence: 66 };

  it("names pages without a text layer as ranges", () => {
    expect(
      getExtractionWarning({ ...digital, pagesWithoutText: [7, 8, 9, 12] }),
    ).toBe(
      "Pages 7–9 and 12 have little or no selectable text and were not read; they may be scanned images. Verify those pages in the original before relying on the analysis.",
    );
    expect(
      getExtractionWarning({ ...digital, pagesWithoutText: [2, 5, 6, 9] }),
    ).toMatch(/^Pages 2, 5–6, and 9 have /);
  });

  it("bounds a long page list with a count of the remaining pages", () => {
    const everyOtherPage = Array.from(
      { length: 20 },
      (_, index) => index * 2 + 1,
    );

    expect(
      getExtractionWarning({ ...digital, pagesWithoutText: everyOtherPage }),
    ).toMatch(/^Pages 1, 3, 5, 7, 9, 11, and 14 more pages have /);
  });

  it("keeps the whole-document and OCR warnings and is silent for clean text", () => {
    expect(
      getExtractionWarning({ method: "pdf_scanned", confidence: 0 }),
    ).toMatch(/appears to be scanned/);
    expect(
      getExtractionWarning({ method: "tesseract_ocr", confidence: 41.6 }),
    ).toMatch(/OCR confidence is low \(42%\)/);
    expect(
      getExtractionWarning({ method: "pdf_parse", confidence: 100 }),
    ).toBeNull();
    expect(
      getExtractionWarning({ ...digital, pagesWithoutText: [] }),
    ).toBeNull();
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
