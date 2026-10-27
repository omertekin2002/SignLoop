import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  getExtractionWarning,
  isDirectUploadRequest,
  parseUpload,
  prepareDirectUpload,
  prepareUpload,
  storeUploadedFile,
  toExtractedText,
} from "./upload-pipeline";
import { MAX_DIRECT_UPLOAD_FILE_SIZE } from "./upload-constants";
import { parseStoredDocument } from "./document-parser";
import type { ReportProgress } from "./operation-progress";

const { findDirectUploadIntent, blobGet, blobDel, requestParse } = vi.hoisted(() => ({
  findDirectUploadIntent: vi.fn(),
  blobGet: vi.fn(),
  blobDel: vi.fn(),
  requestParse: vi.fn(),
}));

vi.mock("@/lib/server-db", () => ({
  createUploadCleanupIntent: vi.fn().mockResolvedValue("intent"),
  findDirectUploadIntent,
}));
vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/blob")>()),
  get: blobGet,
  del: blobDel,
}));
// The parse-only function is reached over HTTP; here the call parses the stored object in-process
// with the same code the function runs.
vi.mock("@/lib/parse-client", () => ({ requestParse }));

const temporaryDirectories: string[] = [];

beforeEach(() => {
  requestParse.mockReset();
  requestParse.mockImplementation(
    (input: { storageKey: string; mimeType: string; signal: AbortSignal }) =>
      parseStoredDocument(input.storageKey, input.mimeType, input.signal),
  );
});

async function useLocalStorage() {
  const storageRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "signloop-upload-"),
  );
  temporaryDirectories.push(storageRoot);
  vi.stubEnv("LOCAL_STORAGE_PATH", storageRoot);
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  return storageRoot;
}

/** What the upload routes do: validate, store (unless already in Blob), then parse. */
async function prepareAndParse(request: Request, progress?: ReportProgress) {
  const prepared = await prepareUpload(request);
  if (!prepared.ok) return prepared;
  const stored =
    prepared.stored ??
    (await storeUploadedFile({
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
      signal: prepared.signal,
    }));
  const extracted = await parseUpload(request, prepared, stored, progress);
  return extracted.ok ? { ...prepared, ...extracted } : extracted;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("prepareUpload then parseUpload", () => {
  beforeEach(useLocalStorage);

  it("rejects zero-byte files", async () => {
    const formData = new FormData();
    formData.set(
      "file",
      new File([], "empty.pdf", { type: "application/pdf" }),
    );

    const result = await prepareAndParse(
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

    const result = await prepareAndParse(
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

      const result = await prepareAndParse(
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

    const result = await prepareAndParse(
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

    const result = await prepareAndParse(
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

    const result = await prepareAndParse(
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

describe("toExtractedText", () => {
  const live = () => new AbortController().signal;

  it.each(["limit", "content"] as const)(
    "answers a %s error with 422 and the parser's message",
    (kind) => {
      expect(
        toExtractedText({ ok: false, kind, message: "Too many pages." }, live()),
      ).toEqual({ ok: false, status: 422, error: "Too many pages." });
    },
  );

  it("answers a transient failure with 503 and its message", () => {
    expect(
      toExtractedText(
        { ok: false, kind: "unavailable", message: "Try again shortly." },
        live(),
      ),
    ).toEqual({ ok: false, status: 503, error: "Try again shortly." });
  });

  it("reports a parser failure as extractionError for the route to answer", () => {
    expect(
      toExtractedText(
        { ok: false, kind: "failed", message: "Text extraction failed" },
        live(),
      ),
    ).toEqual({
      ok: true,
      text: "",
      method: null,
      confidence: null,
      extractionError: "Text extraction failed",
      extractionWarning: null,
    });
  });

  it("answers a canceled upload with 503 whatever the parse result", () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      toExtractedText(
        {
          ok: true,
          text: "Signed",
          method: "plain_text",
          confidence: null,
          sparseTextPages: [],
        },
        controller.signal,
      ),
    ).toEqual({
      ok: false,
      status: 503,
      error: "Upload processing timed out or was canceled.",
    });
  });

  it("refuses text over the extracted-text bound", () => {
    expect(
      toExtractedText(
        {
          ok: true,
          text: "a".repeat(2_000_001),
          method: "plain_text",
          confidence: null,
          sparseTextPages: [],
        },
        live(),
      ),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it("derives the warning from the parse result", () => {
    expect(
      toExtractedText(
        {
          ok: true,
          text: "Scanned",
          method: "tesseract_ocr",
          confidence: 42,
          sparseTextPages: [],
        },
        live(),
      ),
    ).toEqual({
      ok: true,
      text: "Scanned",
      method: "tesseract_ocr",
      confidence: 42,
      extractionError: null,
      extractionWarning:
        "OCR confidence is low (42%). Verify the extracted text before relying on the analysis.",
    });
  });
});

describe("parseUpload", () => {
  const stored = {
    storageKey: "uploads/0b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d",
    bucket: "local-filesystem",
    storageIntentId: "intent",
  };

  it("does not call the parse function for an upload that was already canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    const onStage = vi.fn();

    const result = await parseUpload(
      new Request("http://localhost/upload"),
      { signal: controller.signal, mimeType: "text/plain" },
      stored,
      onStage,
    );

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "Upload processing timed out or was canceled.",
    });
    expect(onStage).not.toHaveBeenCalled();
    expect(requestParse).not.toHaveBeenCalled();
  });

  it("hands the request, stored key, validated type and signal to the parse call", async () => {
    requestParse.mockResolvedValue({
      ok: true,
      text: "Signed agreement",
      method: "plain_text",
      confidence: null,
      sparseTextPages: [],
    });
    const request = new Request("http://localhost/upload");
    const signal = new AbortController().signal;

    const result = await parseUpload(request, { signal, mimeType: "text/plain" }, stored);

    expect(requestParse).toHaveBeenCalledExactlyOnceWith({
      req: request,
      storageKey: stored.storageKey,
      mimeType: "text/plain",
      signal,
    });
    expect(result).toMatchObject({ ok: true, text: "Signed agreement" });
  });
});

describe("storeUploadedFile", () => {
  it("uses unique opaque object keys", async () => {
    const storageRoot = await useLocalStorage();

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

describe("upload extraction progress boundary", () => {
  beforeEach(useLocalStorage);
  it("does not announce extraction before receiving and validating the file", async () => {
    const onStage = vi.fn();
    const form = new FormData(); form.set("file", new File(["Signed agreement"], "contract.txt", { type: "text/plain" }));
    const result = await prepareAndParse(new Request("http://localhost/upload", { method: "POST", body: form }), onStage);
    expect(result.ok).toBe(true);
    expect(onStage).toHaveBeenCalledExactlyOnceWith("extracting");
  });
  it("never announces extraction for a signature validation failure", async () => {
    const onStage = vi.fn();
    const form = new FormData(); form.set("file", new File(["invalid PDF"], "contract.pdf", { type: "application/pdf" }));
    const result = await prepareAndParse(new Request("http://localhost/upload", { method: "POST", body: form }), onStage);
    expect(result.ok).toBe(false); expect(onStage).not.toHaveBeenCalled();
  });
});

describe("prepareUpload fields", () => {
  it("keeps the first string value of each text field and ignores files under field names", async () => {
    const form = new FormData();
    form.set("file", new File(["Signed agreement"], "contract.txt", { type: "text/plain" }));
    form.set("title", new File(["x"], "sneaky.txt", { type: "text/plain" }));
    form.append("documentType", "addendum");
    form.append("documentType", "other");

    const result = await prepareUpload(
      new Request("http://localhost/upload", { method: "POST", body: form }),
    );

    expect(result).toMatchObject({
      ok: true,
      fileName: "contract.txt",
      fields: { documentType: "addendum" },
      stored: null,
    });
    if (!result.ok) throw new Error("expected a prepared upload");
    expect(result.fields).not.toHaveProperty("title");
  });
});

describe("prepareDirectUpload", () => {
  const PATHNAME = "uploads/0b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d";
  const INTENT_ID = "33e3e947-f71f-4ecd-a901-adbf24edbb8a";
  const BLOB_URL = `https://store.private.blob.vercel-storage.com/${PATHNAME}`;
  const target = { kind: "contract" as const, id: "11e3e947-f71f-4ecd-a901-adbf24edbb8a" };

  const finalizeRequest = (body: unknown) =>
    new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const blobResult = (
    chunks: Uint8Array[],
    meta: { contentType?: string; size?: number } = {},
  ) => {
    let index = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });
    return {
      cancel,
      result: {
        statusCode: 200,
        stream,
        headers: new Headers(),
        blob: {
          url: BLOB_URL,
          downloadUrl: `${BLOB_URL}?download=1`,
          pathname: PATHNAME,
          contentDisposition: "inline",
          cacheControl: "private",
          uploadedAt: new Date(),
          etag: "etag",
          contentType: meta.contentType ?? "application/pdf",
          size: meta.size ?? chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
        },
      },
    };
  };

  /** A real PDF with readable text, padded to about 9 MiB with an attachment. */
  async function nineMebibytePdf(): Promise<Buffer> {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage();
    page.drawText("MASTER SERVICES AGREEMENT", { x: 50, y: 700, size: 18, font });
    page.drawText(
      "Either party may terminate this agreement with sixty days written notice.",
      { x: 50, y: 660, size: 11, font },
    );
    await document.attach(randomBytes(9 * 1024 * 1024 - 4096), "padding.bin", {
      mimeType: "application/octet-stream",
    });
    return Buffer.from(await document.save({ useObjectStreams: false }));
  }

  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_secret");
    vi.stubEnv("BLOB_ACCESS", "");
    findDirectUploadIntent.mockResolvedValue(INTENT_ID);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("recognizes finalize requests by their JSON content type", () => {
    expect(isDirectUploadRequest(finalizeRequest({}))).toBe(true);
    const form = new FormData();
    form.set("file", new File(["x"], "x.txt"));
    expect(
      isDirectUploadRequest(new Request("http://localhost/upload", { method: "POST", body: form })),
    ).toBe(false);
  });

  it("finalizes a 9 MiB PDF read back from Blob under the claimed intent", async () => {
    const pdf = await nineMebibytePdf();
    expect(pdf.length).toBeGreaterThan(9 * 1024 * 1024 - 8192);
    expect(pdf.length).toBeLessThanOrEqual(MAX_DIRECT_UPLOAD_FILE_SIZE);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < pdf.length; offset += 1024 * 1024)
      chunks.push(pdf.subarray(offset, offset + 1024 * 1024));
    // Finalize reads the blob to validate it; the parse function reads it again by its URL.
    blobGet
      .mockResolvedValueOnce(blobResult(chunks).result)
      .mockResolvedValueOnce(blobResult(chunks).result);
    const onStage = vi.fn();
    const request = finalizeRequest({
      pathname: PATHNAME,
      fileName: "Scanned lease.pdf",
      title: "Lease",
      documentType: "addendum",
    });

    const prepared = await prepareDirectUpload(request, { userId: "owner", target });
    if (!prepared.ok || !prepared.stored) throw new Error("expected a stored upload");
    const extracted = await parseUpload(request, prepared, prepared.stored, onStage);
    if (!extracted.ok) throw new Error("expected extracted text");
    const result = { ...prepared, ...extracted };

    expect(findDirectUploadIntent).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      pathname: PATHNAME,
      target,
    });
    expect(blobGet).toHaveBeenNthCalledWith(
      1,
      PATHNAME,
      expect.objectContaining({ access: "private", useCache: false }),
    );
    expect(requestParse).toHaveBeenCalledExactlyOnceWith({
      req: request,
      storageKey: BLOB_URL,
      mimeType: "application/pdf",
      signal: prepared.signal,
    });
    expect(blobGet).toHaveBeenNthCalledWith(
      2,
      BLOB_URL,
      expect.objectContaining({ access: "private", useCache: false }),
    );
    expect(result).toMatchObject({
      ok: true,
      fileName: "Scanned lease.pdf",
      mimeType: "application/pdf",
      method: "pdf_parse",
      extractionError: null,
      fields: { title: "Lease", documentType: "addendum" },
      stored: {
        storageKey: BLOB_URL,
        bucket: "vercel-blob",
        storageIntentId: INTENT_ID,
      },
    });
    expect(result.buffer.equals(pdf)).toBe(true);
    expect(result.text).toContain("MASTER SERVICES AGREEMENT");
    expect(result.text).toContain("sixty days written notice");
    expect(onStage).toHaveBeenCalledExactlyOnceWith("extracting");
  }, 30_000);

  it.each([
    ["malformed JSON", "{"],
    ["a client-chosen pathname", { pathname: "contracts/owner/lease.pdf", fileName: "lease.pdf" }],
    ["a pathname with a filename", { pathname: `${PATHNAME}.pdf`, fileName: "lease.pdf" }],
    ["a traversal pathname", { pathname: `uploads/../${PATHNAME}`, fileName: "lease.pdf" }],
    ["a missing file name", { pathname: PATHNAME }],
    ["a blank file name", { pathname: PATHNAME, fileName: "  " }],
  ])("rejects %s without looking up an intent or reading Blob", async (_label, body) => {
    const result = await prepareDirectUpload(finalizeRequest(body), {
      userId: "owner",
      target,
    });

    expect(result).toEqual({ ok: false, status: 400, error: "Invalid upload request" });
    expect(findDirectUploadIntent).not.toHaveBeenCalled();
    expect(blobGet).not.toHaveBeenCalled();
  });

  it("rejects a pathname with no unclaimed intent for this owner's target without reading Blob", async () => {
    findDirectUploadIntent.mockResolvedValue(null);

    const result = await prepareDirectUpload(
      finalizeRequest({ pathname: PATHNAME, fileName: "lease.pdf" }),
      { userId: "intruder", target },
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "The uploaded file was not found. Upload it again.",
    });
    expect(findDirectUploadIntent).toHaveBeenCalledExactlyOnceWith({
      userId: "intruder",
      pathname: PATHNAME,
      target,
    });
    expect(blobGet).not.toHaveBeenCalled();
  });

  it("reports a blob that was never uploaded as not found", async () => {
    blobGet.mockResolvedValue(null);

    const result = await prepareDirectUpload(
      finalizeRequest({ pathname: PATHNAME, fileName: "lease.pdf" }),
      { userId: "owner", target },
    );

    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a blob whose reported size is over 10 MiB without reading it", async () => {
    const { result: blob, cancel } = blobResult([new Uint8Array(16)], {
      size: MAX_DIRECT_UPLOAD_FILE_SIZE + 1,
    });
    blobGet.mockResolvedValue(blob);

    const result = await prepareDirectUpload(
      finalizeRequest({ pathname: PATHNAME, fileName: "lease.pdf" }),
      { userId: "owner", target },
    );

    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "File too large. Maximum size is 10 MB.",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("stops reading past 10 MiB even when Blob reports a smaller size", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 12 }, () => chunk);
    const { result: blob, cancel } = blobResult(chunks, { size: 1024 });
    blobGet.mockResolvedValue(blob);

    const result = await prepareDirectUpload(
      finalizeRequest({ pathname: PATHNAME, fileName: "lease.pdf" }),
      { userId: "owner", target },
    );

    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects bytes that fail the signature check and leaves the blob for the outbox", async () => {
    blobGet.mockResolvedValue(
      blobResult([Buffer.from("<html>not a pdf</html>")]).result,
    );

    const result = await prepareDirectUpload(
      finalizeRequest({ pathname: PATHNAME, fileName: "lease.pdf" }),
      { userId: "owner", target },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/contents do not match/i),
    });
    expect(blobDel).not.toHaveBeenCalled();
  });

  it("rejects a declared type that does not match the file name", async () => {
    blobGet.mockResolvedValue(
      blobResult([Buffer.from("%PDF-1.4\n")], { contentType: "image/png" }).result,
    );

    const result = await prepareDirectUpload(
      finalizeRequest({ pathname: PATHNAME, fileName: "lease.pdf" }),
      { userId: "owner", target },
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("answers 503 when Blob cannot be read", async () => {
    blobGet.mockRejectedValue(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await prepareDirectUpload(
      finalizeRequest({ pathname: PATHNAME, fileName: "lease.pdf" }),
      { userId: "owner", target },
    );

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "The uploaded file could not be read. Please try again.",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
