import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getContractMetaForUser,
  saveContractUploadForUser,
  prepareUpload,
  storeUploadedFile,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getContractMetaForUser: vi.fn(),
  saveContractUploadForUser: vi.fn(),
  prepareUpload: vi.fn(),
  storeUploadedFile: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  getContractMetaForUser,
  saveContractUploadForUser,
}));
vi.mock("@/lib/upload-pipeline", () => ({ prepareUpload, storeUploadedFile }));

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
  formData: new FormData(),
  file: new File(["lease"], "lease.pdf", { type: "application/pdf" }),
  buffer: Buffer.from("%PDF-1.4 lease"),
  mimeType: "application/pdf",
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
    [422, "Extracted text is too large. Maximum length is 500,000 characters."],
    [503, "Upload processing timed out or was canceled."],
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
    prepareUpload.mockResolvedValue(
      preparedUpload({
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
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(saveContractUploadForUser).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t  "],
  ])("returns 400 when the extracted text is %s", async (_label, text) => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractMetaForUser.mockResolvedValue(contractMeta());
    prepareUpload.mockResolvedValue(preparedUpload({ text }));

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Could not extract any text from the file",
    });
    expect(storeUploadedFile).not.toHaveBeenCalled();
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
    const prepared = preparedUpload({ confidence: 97.5 });
    prepareUpload.mockResolvedValue(prepared);
    storeUploadedFile.mockResolvedValue(storedFile());
    saveContractUploadForUser.mockResolvedValue(true);

    const response = await POST(uploadRequest(), params(CONTRACT_ID));

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
      sizeBytes: prepared.file.size,
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
    prepareUpload.mockResolvedValue(
      preparedUpload({
        mimeType: "image/png",
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
