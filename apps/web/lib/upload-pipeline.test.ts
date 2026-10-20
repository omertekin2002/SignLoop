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

  it.each([
    [
      "after 8 KiB of UTF-8 text",
      Buffer.from(`${"A".repeat(9_000)}\u0000Notice period: 30 days.`),
    ],
    [
      "in big-endian UTF-16 text",
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from("Notice period:\u000030 days.", "utf16le").swap16(),
      ]),
    ],
  ])(
    "rejects a text file with a NUL character %s as unprocessable",
    async (_, contents) => {
      const formData = new FormData();
      formData.set(
        "file",
        new File([contents], "contract.txt", { type: "text/plain" }),
      );

      const result = await prepareUpload(
        new Request("http://localhost/upload", {
          method: "POST",
          body: formData,
        }),
      );

      expect(result).toEqual({
        ok: false,
        status: 422,
        error:
          "The file's text contains a null character (U+0000), which cannot be stored. Remove it, or save the document in another format, and upload it again.",
      });
    },
  );

  it("keeps clean UTF-16 text with line breaks and Unicode intact", async () => {
    const text = "Notice period:\t30 days\r\nİptal şartı — 30 gün ✍️";
    const formData = new FormData();
    formData.set(
      "file",
      new File(
        [
          Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(text, "utf16le"),
          ]),
        ],
        "contract.txt",
        { type: "text/plain" },
      ),
    );

    const result = await prepareUpload(
      new Request("http://localhost/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      text,
      method: "plain_text",
      extractionError: null,
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
        "Page 2 has little or no selectable text. Any text on it is included, but if it is a scanned image, its content is missing from the analysis. Verify that page in the original before relying on the analysis.",
    });
    if (!result.ok) throw new Error("expected a prepared upload");
    expect(result.text).toContain("MASTER SERVICES AGREEMENT");
    expect(result.text).toContain("sixty days written notice.");
  });

  it("keeps a short cover page's text and does not call that page unread", async () => {
    // Synthetic text PDF whose page 1 is only "EXHIBIT A" (fixtures/README.md).
    const pdf = await fs.readFile(
      new URL("./fixtures/pdf-short-cover-page.pdf", import.meta.url),
    );
    const formData = new FormData();
    formData.set(
      "file",
      new File([pdf], "exhibit.pdf", { type: "application/pdf" }),
    );

    const result = await prepareUpload(
      new Request("http://localhost/upload", {
        method: "POST",
        body: formData,
      }),
    );

    if (!result.ok) throw new Error("expected a prepared upload");
    expect(result).toMatchObject({
      method: "pdf_parse",
      confidence: 66,
      extractionError: null,
    });
    expect(result.text).toMatch(/^EXHIBIT A SCHEDULE OF SERVICES 1\. Scope\./);
    // The page is still flagged, since a scan can carry this little text, but the stored warning
    // says its text is included rather than that the page was not read.
    expect(result.extractionWarning).toMatch(
      /^Page 1 has little or no selectable text\. Any text on it is included,/,
    );
    expect(result.extractionWarning).not.toMatch(/not read|omitted|skipped/i);
  });
});

describe("getExtractionWarning", () => {
  const digital = { method: "pdf_parse" as const, confidence: 66 };

  it("names sparse pages as ranges", () => {
    expect(
      getExtractionWarning({ ...digital, sparseTextPages: [7, 8, 9, 12] }),
    ).toBe(
      "Pages 7–9 and 12 have little or no selectable text. Any text on them is included, but if they are scanned images, their content is missing from the analysis. Verify those pages in the original before relying on the analysis.",
    );
    expect(
      getExtractionWarning({ ...digital, sparseTextPages: [2, 5, 6, 9] }),
    ).toMatch(/^Pages 2, 5–6, and 9 have /);
  });

  it("bounds a long page list with a count of the remaining pages", () => {
    const everyOtherPage = Array.from(
      { length: 20 },
      (_, index) => index * 2 + 1,
    );

    expect(
      getExtractionWarning({ ...digital, sparseTextPages: everyOtherPage }),
    ).toMatch(/^Pages 1, 3, 5, 7, 9, 11, and 14 more pages have /);
    expect(
      getExtractionWarning({
        ...digital,
        sparseTextPages: everyOtherPage.slice(0, 7),
      }),
    ).toMatch(/^Pages 1, 3, 5, 7, 9, 11, and 1 more page have /);
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
      getExtractionWarning({ ...digital, sparseTextPages: [] }),
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
