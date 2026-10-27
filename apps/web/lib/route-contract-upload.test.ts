function progressDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getContractMetaForUser,
  saveContractUploadForUser,
  prepareUpload,
  prepareDirectUpload,
  storeUploadedFile,
  parseUpload,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getContractMetaForUser: vi.fn(),
  saveContractUploadForUser: vi.fn(),
  prepareUpload: vi.fn(),
  prepareDirectUpload: vi.fn(),
  storeUploadedFile: vi.fn(),
  parseUpload: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  getContractMetaForUser,
  saveContractUploadForUser,
}));
vi.mock("@/lib/upload-pipeline", async (importOriginal) => ({
  isDirectUploadRequest: (
    await importOriginal<typeof import("@/lib/upload-pipeline")>()
  ).isDirectUploadRequest,
  prepareUpload,
  prepareDirectUpload,
  storeUploadedFile,
  parseUpload,
}));

import { maxDuration, POST } from "@/app/api/contracts/[id]/upload/route";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const PROJECT_ID = "5b7d7f63-8f61-4a52-9d6f-3a0c1b2e4d10";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const uploadRequest = () => {
  const body = new FormData();
  body.set("file", new File(["lease"], "lease.pdf", { type: "application/pdf" }));
  return new Request(`http://localhost/api/contracts/${CONTRACT_ID}/upload`, {
    method: "POST",
    body,
  });
};

const contractMeta = () => ({
  id: CONTRACT_ID,
  userId: "owner",
  projectId: PROJECT_ID,
  title: "Master services agreement",
  status: "DRAFT",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:05:00.000Z",
});

const preparedUpload = (overrides: Record<string, unknown> = {}) => ({
  ok: true as const,
  signal: new AbortController().signal,
  fields: {},
  fileName: "lease.pdf",
  stored: null,
  buffer: Buffer.from("%PDF-1.4 lease"),
  mimeType: "application/pdf",
  ...overrides,
});

// What the parse-only function's answer becomes (parseUpload).
const extractedText = (overrides: Record<string, unknown> = {}) => ({
  ok: true as const,
  text: "This lease renews automatically.",
  method: "pdf_parse",
  confidence: null,
  extractionError: null,
  extractionWarning: null,
  ...overrides,
});

const storedFile = () => ({
  storageKey: "https://storage.example/uploads/abc",
  bucket: "signloop-uploads",
  storageIntentId: "33e3e947-f71f-4ecd-a901-adbf24edbb8a",
});

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  parseUpload.mockResolvedValue(extractedText());
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/contracts/[id]/upload", () => {
  it("allows enough time for OCR on scanned uploads", () => {
    expect(maxDuration).toBe(180);
  });

  it("returns 401 without touching the database or the upload when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getContractMetaForUser).not.toHaveBeenCalled();
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-uuid string", "not-a-uuid"],
    ["a path traversal attempt", "../../etc/passwd"],
    ["a uuid with trailing characters", `${CONTRACT_ID}-extra`],
    ["an empty string", ""],
  ])("returns 404 for %s without querying or reading the body", async (_label, id) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await POST(uploadRequest(), params(id));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(getContractMetaForUser).not.toHaveBeenCalled();
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(storeUploadedFile).not.toHaveBeenCalled();
  });

  it("returns 404 when the contract is not owned by the caller, before reading the body", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getContractMetaForUser.mockResolvedValue(null);

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(getContractMetaForUser).toHaveBeenCalledExactlyOnceWith(
      "intruder",
      CONTRACT_ID,
    );
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });

  it("propagates a database failure while loading the contract instead of reading the upload", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockRejectedValue(new Error("db down"));

    await expect(POST(uploadRequest(), params(CONTRACT_ID))).rejects.toThrow(
      "db down",
    );
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(storeUploadedFile).not.toHaveBeenCalled();
  });

  it.each([
    [400, "The uploaded file is empty"],
    [400, "Invalid multipart upload"],
    [413, "File too large. Maximum size is 10 MB."],
    [503, "Upload timed out or was canceled."],
  ])(
    "passes through the pipeline validation failure %i (%s) without storing anything",
    async (status, error) => {
      auth.mockResolvedValue({ userId: "owner" });
      getContractMetaForUser.mockResolvedValue(contractMeta());
      prepareUpload.mockResolvedValue({ ok: false, status, error });

      const response = await POST(uploadRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(storeUploadedFile).not.toHaveBeenCalled();
      expect(saveContractUploadForUser).not.toHaveBeenCalled();
    },
  );

  it.each([
    [422, "Extracted text is too large. Maximum length is 2,000,000 characters."],
    [503, "Image text extraction is unavailable right now. Please try again shortly."],
    [503, "Upload processing timed out or was canceled."],
  ])(
    "passes through the parse failure %i (%s) after storing, without saving",
    async (status, error) => {
      auth.mockResolvedValue({ userId: "owner" });
      getContractMetaForUser.mockResolvedValue(contractMeta());
      prepareUpload.mockResolvedValue(preparedUpload());
      storeUploadedFile.mockResolvedValue(storedFile());
      parseUpload.mockResolvedValue({ ok: false, status, error });

      const response = await POST(uploadRequest(), params(CONTRACT_ID));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(storeUploadedFile).toHaveBeenCalledOnce();
      expect(saveContractUploadForUser).not.toHaveBeenCalled();
    },
  );

  it("rejects text with a late NUL character through the real parsers without saving", async () => {
    const pipeline = await vi.importActual<
      typeof import("@/lib/upload-pipeline")
    >("@/lib/upload-pipeline");
    const { parseDocument } = await vi.importActual<
      typeof import("@/lib/document-parser")
    >("@/lib/document-parser");
    prepareUpload.mockImplementation(pipeline.prepareUpload);
    storeUploadedFile.mockResolvedValue(storedFile());
    // The parse-only function's work, in-process on the validated bytes.
    parseUpload.mockImplementation(
      async (_req: Request, prepared: { buffer: Buffer; mimeType: string; signal: AbortSignal }) =>
        pipeline.toExtractedText(
          await parseDocument(prepared.buffer, prepared.mimeType, prepared.signal),
          prepared.signal,
        ),
    );
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    const body = new FormData();
    body.set(
      "file",
      new File(
        [`${"A".repeat(9_000)}\u0000Notice period: 30 days.`],
        "contract.txt",
        { type: "text/plain" },
      ),
    );

    const response = await POST(
      new Request(`http://localhost/api/contracts/${CONTRACT_ID}/upload`, {
        method: "POST",
        body,
      }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "The file's text contains a null character (U+0000), which cannot be stored. Remove it, or save the document in another format, and upload it again.",
    });
    expect(storeUploadedFile).toHaveBeenCalledOnce();
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });

  it("hands the original request to the upload pipeline", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Upload exactly one file",
    });
    const request = uploadRequest();

    await POST(request, params(CONTRACT_ID));

    expect(prepareUpload).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("returns 422 with a generic message when text extraction threw, without leaking the cause", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    parseUpload.mockResolvedValue(
      extractedText({
        text: "",
        method: null,
        extractionError: "bad xref table at offset 4096",
      }),
    );

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      error:
        "Text could not be extracted. Verify the file is valid and try again.",
    });
    expect(JSON.stringify(body)).not.toContain("xref");
    expect(consoleError).toHaveBeenCalledWith(
      "Text extraction failed:",
      "bad xref table at offset 4096",
    );
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t  "],
  ])("returns 400 when the extracted text is %s", async (_label, text) => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    parseUpload.mockResolvedValue(extractedText({ text }));

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Could not extract any text from the file",
    });
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });

  it("returns 500 when the file cannot be stored and does not save anything", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockRejectedValue(new Error("bucket unreachable"));

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: "Failed to store the uploaded file. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain("bucket unreachable");
    expect(consoleError).toHaveBeenCalledWith(
      "Upload storage failed:",
      expect.any(Error),
    );
    expect(parseUpload).not.toHaveBeenCalled();
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });

  it("returns 404 when the contract disappears before the upload is saved", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    saveContractUploadForUser.mockResolvedValue(false);

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(saveContractUploadForUser).toHaveBeenCalledOnce();
  });

  it("returns 500 when persisting the upload fails", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    saveContractUploadForUser.mockRejectedValue(new Error("deadlock detected"));

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: "Failed to save the uploaded file. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain("deadlock");
    expect(consoleError).toHaveBeenCalledWith(
      "Upload persistence failed:",
      expect.any(Error),
    );
  });

  it("stores the file and saves it for the owner, then reports the extraction result", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    const prepared = preparedUpload();
    prepareUpload.mockResolvedValue(prepared);
    storeUploadedFile.mockResolvedValue(storedFile());
    parseUpload.mockResolvedValue(extractedText({ confidence: 97.5 }));
    saveContractUploadForUser.mockResolvedValue(true);
    const request = uploadRequest();

    const response = await POST(request, params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: "File uploaded and text extracted",
      extractionMethod: "pdf_parse",
      confidence: 97.5,
      textLength: "This lease renews automatically.".length,
    });
    expect(getContractMetaForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      CONTRACT_ID,
    );
    expect(storeUploadedFile).toHaveBeenCalledExactlyOnceWith({
      buffer: prepared.buffer,
      signal: prepared.signal,
      mimeType: "application/pdf",
    });
    // The stored object is what the parse-only function reads.
    expect(parseUpload).toHaveBeenCalledExactlyOnceWith(
      request,
      prepared,
      storedFile(),
    );
    expect(saveContractUploadForUser).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      contractId: CONTRACT_ID,
      text: "This lease renews automatically.",
      extractionWarning: null,
      projectId: PROJECT_ID,
      title: "Master services agreement",
      fileName: "lease.pdf",
      storageKey: "https://storage.example/uploads/abc",
      storageIntentId: "33e3e947-f71f-4ecd-a901-adbf24edbb8a",
      bucket: "signloop-uploads",
      contentType: "application/pdf",
      sizeBytes: prepared.buffer.length,
      extractionMethod: "pdf_parse",
      extractionConfidence: 97.5,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("includes the extraction warning in the response only when there is one", async () => {
    const warning =
      "OCR confidence is low (42%). Verify the extracted text before relying on the analysis.";
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload({ mimeType: "image/png" }));
    parseUpload.mockResolvedValue(
      extractedText({
        method: "tesseract_ocr",
        confidence: 42,
        extractionWarning: warning,
      }),
    );
    storeUploadedFile.mockResolvedValue(storedFile());
    saveContractUploadForUser.mockResolvedValue(true);

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      extractionMethod: "tesseract_ocr",
      confidence: 42,
      warning,
    });
    expect(saveContractUploadForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionWarning: warning,
        contentType: "image/png",
        extractionMethod: "tesseract_ocr",
        extractionConfidence: 42,
      }),
    );
  });

  it("omits the warning field when extraction produced none", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    saveContractUploadForUser.mockResolvedValue(true);

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(await response.json()).not.toHaveProperty("warning");
  });

  it("saves a contract with no project using a null projectId", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue({
      ...contractMeta(),
      projectId: null,
    });
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    saveContractUploadForUser.mockResolvedValue(true);

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(saveContractUploadForUser).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: null, userId: "owner" }),
    );
  });
});

import { PROGRESS_MEDIA_TYPE, isUploadResult } from "./operation-progress";
import { readOperationResponse } from "./operation-progress-client";
const progressUploadRequest = () => {
  const request = uploadRequest(); request.headers.set("Accept", PROGRESS_MEDIA_TYPE); return request;
};

describe("contract upload progress", () => {
  it.each(["signed-out", "not-owned"])("retains %s preflight JSON without reading the upload", async (mode) => {
    auth.mockResolvedValue({ userId: mode === "signed-out" ? null : "intruder" });
    getContractMetaForUser.mockResolvedValue(null);
    const response = await POST(progressUploadRequest(), params(CONTRACT_ID));
    expect(response.status).toBe(mode === "signed-out" ? 401 : 404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(prepareUpload).not.toHaveBeenCalled();
  });
  it("streams uploading during storage, extraction while parsing, and success only after the owner write", async () => {
    auth.mockResolvedValue({ userId: "owner" }); getContractMetaForUser.mockResolvedValue(contractMeta());
    const extraction = progressDeferred<void>(); const storage = progressDeferred<void>(); const save = progressDeferred<boolean>();
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockImplementation(async () => { await storage.promise; return storedFile(); });
    parseUpload.mockImplementation(async (_req, _prepared, _stored, progress) => { progress("extracting"); await extraction.promise; return extractedText({ extractionWarning: "Verify page 2" }); });
    saveContractUploadForUser.mockReturnValue(save.promise);
    const response = await POST(progressUploadRequest(), params(CONTRACT_ID));
    const onStage = vi.fn(); const finished = vi.fn();
    const reading = readOperationResponse(response, { onStage, validate: isUploadResult }).then(finished);
    await vi.waitFor(() => expect(storeUploadedFile).toHaveBeenCalledOnce());
    expect(onStage.mock.calls.flat()).toEqual(["uploading"]); expect(parseUpload).not.toHaveBeenCalled(); storage.resolve();
    await vi.waitFor(() => expect(onStage.mock.calls.flat()).toEqual(["uploading", "extracting"]));
    expect(saveContractUploadForUser).not.toHaveBeenCalled(); extraction.resolve();
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith("saving"));
    await vi.waitFor(() => expect(saveContractUploadForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", contractId: CONTRACT_ID })));
    expect(finished).not.toHaveBeenCalled(); save.resolve(true); await reading;
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ success: true, warning: "Verify page 2" }));
  });
  it.each(["extraction", "missing-owner", "storage"])("preserves late %s failure without a successful result", async (failure) => {
    auth.mockResolvedValue({ userId: "owner" }); getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload());
    parseUpload.mockImplementation(async (_req, _prepared, _stored, progress) => { progress("extracting"); return extractedText(failure === "extraction" ? { extractionError: "private", text: "" } : {}); });
    storeUploadedFile.mockImplementation(async () => { if (failure === "storage") throw new Error("down"); return storedFile(); });
    saveContractUploadForUser.mockResolvedValue(false);
    const response = await POST(progressUploadRequest(), params(CONTRACT_ID));
    await expect(readOperationResponse(response, { validate: isUploadResult })).rejects.toMatchObject({ response: { status: failure === "extraction" ? 422 : failure === "storage" ? 500 : 404 } });
    if (failure !== "missing-owner") expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });
  it("aborts pending storage and never starts the owner write after cancellation", async () => {
    auth.mockResolvedValue({ userId: "owner" }); getContractMetaForUser.mockResolvedValue(contractMeta());
    const storage = progressDeferred<void>(); let signal!: AbortSignal;
    prepareUpload.mockImplementation(async (request) => preparedUpload({ signal: request.signal }));
    storeUploadedFile.mockImplementation(async (input) => { signal = input.signal; await storage.promise; return storedFile(); });
    const response = await POST(progressUploadRequest(), params(CONTRACT_ID));
    await vi.waitFor(() => expect(storeUploadedFile).toHaveBeenCalledOnce());
    const canceling = response.body!.cancel(); expect(signal.aborted).toBe(true); storage.resolve();
    await canceling;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });
});


it("does not start the upload metadata write if its processing deadline expires during storage", async () => {
  auth.mockResolvedValue({ userId: "owner" });
  getContractMetaForUser.mockResolvedValue(contractMeta());
  const deadline = new AbortController();
  prepareUpload.mockResolvedValue(preparedUpload({ signal: deadline.signal }));
  const storage = progressDeferred<void>();
  storeUploadedFile.mockImplementation(async () => { await storage.promise; return storedFile(); });
  const response = await POST(progressUploadRequest(), params(CONTRACT_ID));
  await vi.waitFor(() => expect(storeUploadedFile).toHaveBeenCalledOnce());
  deadline.abort(new DOMException("Processing deadline", "TimeoutError"));
  storage.resolve();
  await expect(readOperationResponse(response, { validate: isUploadResult })).rejects.toMatchObject({ response: { status: 500 } });
  expect(saveContractUploadForUser).not.toHaveBeenCalled();
});

describe("POST /api/contracts/[id]/upload finalizing a direct upload", () => {
  const PATHNAME = "uploads/0b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d";
  const BLOB_URL = `https://store.private.blob.vercel-storage.com/${PATHNAME}`;
  const finalizeRequest = () =>
    new Request(`http://localhost/api/contracts/${CONTRACT_ID}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pathname: PATHNAME, fileName: "scan.pdf" }),
    });

  it("saves the blob under its claimed intent without storing the bytes again", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    const prepared = preparedUpload({
      fileName: "scan.pdf",
      buffer: Buffer.alloc(9 * 1024 * 1024, "%PDF"),
      stored: {
        storageKey: BLOB_URL,
        bucket: "vercel-blob",
        storageIntentId: "44e3e947-f71f-4ecd-a901-adbf24edbb8a",
      },
    });
    prepareDirectUpload.mockResolvedValue(prepared);
    saveContractUploadForUser.mockResolvedValue(true);
    const request = finalizeRequest();

    const response = await POST(request, params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(prepareDirectUpload).toHaveBeenCalledExactlyOnceWith(request, {
      userId: "owner",
      target: { kind: "contract", id: CONTRACT_ID },
    });
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(parseUpload).toHaveBeenCalledExactlyOnceWith(
      request,
      prepared,
      prepared.stored,
    );
    expect(saveContractUploadForUser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: "owner",
        contractId: CONTRACT_ID,
        fileName: "scan.pdf",
        storageKey: BLOB_URL,
        storageIntentId: "44e3e947-f71f-4ecd-a901-adbf24edbb8a",
        bucket: "vercel-blob",
        sizeBytes: 9 * 1024 * 1024,
      }),
    );
  });

  it("checks contract ownership before touching the uploaded blob", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getContractMetaForUser.mockResolvedValue(null);

    const response = await POST(finalizeRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(prepareDirectUpload).not.toHaveBeenCalled();
  });

  it("passes through a refused finalize without saving anything", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareDirectUpload.mockResolvedValue({
      ok: false,
      status: 404,
      error: "The uploaded file was not found. Upload it again.",
    });

    const response = await POST(finalizeRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "The uploaded file was not found. Upload it again.",
    });
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });
});
