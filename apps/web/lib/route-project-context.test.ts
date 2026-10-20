import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  isProjectOwnedByUser,
  listProjectContextDocumentsForUser,
  addContextDocumentToProject,
  prepareUpload,
  storeUploadedFile,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  isProjectOwnedByUser: vi.fn(),
  listProjectContextDocumentsForUser: vi.fn(),
  addContextDocumentToProject: vi.fn(),
  prepareUpload: vi.fn(),
  storeUploadedFile: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  isProjectOwnedByUser,
  listProjectContextDocumentsForUser,
  addContextDocumentToProject,
}));
vi.mock("@/lib/upload-pipeline", () => ({ prepareUpload, storeUploadedFile }));

import { GET, maxDuration, POST } from "@/app/api/projects/[id]/context/route";
import { ProjectNotFoundError } from "@/lib/errors";

const PROJECT_ID = "5b7d7f63-8f61-4a52-9d6f-3a0c1b2e4d10";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const getRequest = () =>
  new Request(`http://localhost/api/projects/${PROJECT_ID}/context`);
const uploadRequest = () => {
  const body = new FormData();
  body.set("file", new File(["addendum"], "addendum.pdf", { type: "application/pdf" }));
  return new Request(`http://localhost/api/projects/${PROJECT_ID}/context`, {
    method: "POST",
    body,
  });
};

const INVALID_IDS: Array<[string, string]> = [
  ["a non-uuid string", "not-a-uuid"],
  ["a path traversal attempt", "../../etc/passwd"],
  ["a uuid with trailing characters", `${PROJECT_ID}-extra`],
  ["an empty string", ""],
];

const preparedUpload = (
  overrides: Record<string, unknown> = {},
  fields: Record<string, string> = {},
) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return {
    ok: true as const,
    signal: new AbortController().signal,
    formData,
    file: new File(["addendum"], "addendum.pdf", { type: "application/pdf" }),
    buffer: Buffer.from("%PDF-1.4 addendum"),
    mimeType: "application/pdf",
    text: "The supplier may raise fees once per year.",
    method: "pdf_parse",
    confidence: null,
    extractionError: null,
    extractionWarning: null,
    ...overrides,
  };
};

const storedFile = () => ({
  storageKey: "https://storage.example/uploads/ctx",
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

describe("project context route config", () => {
  it("allows enough time for OCR on scanned context documents", () => {
    expect(maxDuration).toBe(180);
  });
});

describe("GET /api/projects/[id]/context", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(getRequest(), params(PROJECT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(isProjectOwnedByUser).not.toHaveBeenCalled();
    expect(listProjectContextDocumentsForUser).not.toHaveBeenCalled();
  });

  it.each(INVALID_IDS)(
    "returns 404 for %s without querying the database",
    async (_label, id) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await GET(getRequest(), params(id));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Project not found" });
      expect(isProjectOwnedByUser).not.toHaveBeenCalled();
      expect(listProjectContextDocumentsForUser).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the project is not owned by the caller", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    isProjectOwnedByUser.mockResolvedValue(false);

    const response = await GET(getRequest(), params(PROJECT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(isProjectOwnedByUser).toHaveBeenCalledExactlyOnceWith(
      "intruder",
      PROJECT_ID,
    );
    expect(listProjectContextDocumentsForUser).not.toHaveBeenCalled();
  });

  it("propagates a database failure during the ownership probe", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockRejectedValue(new Error("db down"));

    await expect(GET(getRequest(), params(PROJECT_ID))).rejects.toThrow(
      "db down",
    );
    expect(listProjectContextDocumentsForUser).not.toHaveBeenCalled();
  });

  it("lists the owner's context documents with a total", async () => {
    const documents = [
      { id: "doc-1", title: "Addendum", documentType: "other" },
      { id: "doc-2", title: "Term sheet", documentType: "term_sheet" },
    ];
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    listProjectContextDocumentsForUser.mockResolvedValue(documents);

    const response = await GET(getRequest(), params(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: documents, total: 2 });
    expect(isProjectOwnedByUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      PROJECT_ID,
    );
    expect(listProjectContextDocumentsForUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      PROJECT_ID,
    );
  });

  it("returns an empty list with a zero total when the project has no context documents", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    listProjectContextDocumentsForUser.mockResolvedValue([]);

    const response = await GET(getRequest(), params(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], total: 0 });
  });
});

describe("POST /api/projects/[id]/context", () => {
  it("returns 401 without touching the database or the upload when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(isProjectOwnedByUser).not.toHaveBeenCalled();
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(addContextDocumentToProject).not.toHaveBeenCalled();
  });

  it.each(INVALID_IDS)(
    "returns 404 for %s without querying or reading the body",
    async (_label, id) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await POST(uploadRequest(), params(id));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Project not found" });
      expect(isProjectOwnedByUser).not.toHaveBeenCalled();
      expect(prepareUpload).not.toHaveBeenCalled();
      expect(storeUploadedFile).not.toHaveBeenCalled();
    },
  );

  it("returns 404 for a non-owned project before reading the body or storing the blob", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    isProjectOwnedByUser.mockResolvedValue(false);

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(isProjectOwnedByUser).toHaveBeenCalledExactlyOnceWith(
      "intruder",
      PROJECT_ID,
    );
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(addContextDocumentToProject).not.toHaveBeenCalled();
  });

  it("propagates a database failure during the ownership probe instead of reading the upload", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockRejectedValue(new Error("db down"));

    await expect(POST(uploadRequest(), params(PROJECT_ID))).rejects.toThrow(
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
      isProjectOwnedByUser.mockResolvedValue(true);
      prepareUpload.mockResolvedValue({ ok: false, status, error });

      const response = await POST(uploadRequest(), params(PROJECT_ID));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(storeUploadedFile).not.toHaveBeenCalled();
      expect(addContextDocumentToProject).not.toHaveBeenCalled();
    },
  );

  it("rejects text with a late NUL character through the real pipeline before storage", async () => {
    const { prepareUpload: realPrepareUpload } = await vi.importActual<
      typeof import("@/lib/upload-pipeline")
    >("@/lib/upload-pipeline");
    prepareUpload.mockImplementation(realPrepareUpload);
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
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
      new Request(`http://localhost/api/projects/${PROJECT_ID}/context`, {
        method: "POST",
        body,
      }),
      params(PROJECT_ID),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "The file's text contains a null character (U+0000), which cannot be stored. Remove it, or save the document in another format, and upload it again.",
    });
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(addContextDocumentToProject).not.toHaveBeenCalled();
  });

  it("hands the original request to the upload pipeline", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Upload exactly one file",
    });
    const request = uploadRequest();

    await POST(request, params(PROJECT_ID));

    expect(prepareUpload).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("returns 422 with a generic message when text extraction threw, without leaking the cause", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(
      preparedUpload({
        text: "",
        method: null,
        extractionError: "bad xref table at offset 4096",
      }),
    );

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      error:
        "Text could not be extracted. Verify the file is valid and try again.",
    });
    expect(JSON.stringify(body)).not.toContain("xref");
    expect(consoleError).toHaveBeenCalledWith(
      "Context text extraction failed:",
      "bad xref table at offset 4096",
    );
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(addContextDocumentToProject).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t  "],
  ])("returns 422 when the extracted text is %s", async (_label, text) => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(preparedUpload({ text }));

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Could not extract any text from the context document",
    });
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(addContextDocumentToProject).not.toHaveBeenCalled();
  });

  it("returns 500 when the file cannot be stored and does not save anything", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockRejectedValue(new Error("bucket unreachable"));

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: "Failed to store the context document. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain("bucket unreachable");
    expect(consoleError).toHaveBeenCalledWith(
      "Context upload storage failed:",
      expect.any(Error),
    );
    expect(addContextDocumentToProject).not.toHaveBeenCalled();
  });

  it("returns 404 when the project disappears before the document is saved", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockRejectedValue(new ProjectNotFoundError());

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(addContextDocumentToProject).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns 500 when persisting the document fails", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockRejectedValue(
      new Error("deadlock detected"),
    );

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: "Failed to save the context document. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain("deadlock");
    expect(consoleError).toHaveBeenCalledWith(
      "Context upload persistence failed:",
      expect.any(Error),
    );
  });

  it("stores the file and saves it for the owner, then reports the extraction result", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    const prepared = preparedUpload(
      { confidence: 97.5 },
      { title: "  Supplier addendum  ", documentType: " addendum " },
    );
    prepareUpload.mockResolvedValue(prepared);
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockResolvedValue({ id: "doc-9" });

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      message: "Context document uploaded successfully",
      documentId: "doc-9",
      extractionMethod: "pdf_parse",
      extractionConfidence: 97.5,
      extractionFailed: false,
    });
    expect(isProjectOwnedByUser).toHaveBeenCalledExactlyOnceWith(
      "owner",
      PROJECT_ID,
    );
    expect(storeUploadedFile).toHaveBeenCalledExactlyOnceWith({
      buffer: prepared.buffer,
      signal: prepared.signal,
      mimeType: "application/pdf",
    });
    expect(addContextDocumentToProject).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      projectId: PROJECT_ID,
      title: "Supplier addendum",
      documentType: "addendum",
      storageKey: "https://storage.example/uploads/ctx",
      storageIntentId: "33e3e947-f71f-4ecd-a901-adbf24edbb8a",
      bucket: "signloop-uploads",
      originalFilename: "addendum.pdf",
      contentType: "application/pdf",
      sizeBytes: prepared.file.size,
      extractedText: "The supplier may raise fees once per year.",
      extractionWarning: null,
      wordCount: 8,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("falls back to the file name and the other document type when the form fields are missing or blank", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(
      preparedUpload({}, { title: "   ", documentType: "" }),
    );
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockResolvedValue({ id: "doc-9" });

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(201);
    expect(addContextDocumentToProject).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "addendum.pdf",
        documentType: "other",
      }),
    );
  });

  it("falls back to the file name and type when the form has no title or documentType at all", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockResolvedValue({ id: "doc-9" });

    await POST(uploadRequest(), params(PROJECT_ID));

    expect(addContextDocumentToProject).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "addendum.pdf",
        documentType: "other",
      }),
    );
  });

  it("ignores a file uploaded under the title field instead of using it as a string", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    const prepared = preparedUpload();
    prepared.formData.set(
      "title",
      new File(["x"], "sneaky.txt", { type: "text/plain" }),
    );
    prepareUpload.mockResolvedValue(prepared);
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockResolvedValue({ id: "doc-9" });

    await POST(uploadRequest(), params(PROJECT_ID));

    expect(addContextDocumentToProject).toHaveBeenCalledWith(
      expect.objectContaining({ title: "addendum.pdf" }),
    );
  });

  it("counts words across any whitespace in the extracted text", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(
      preparedUpload({ text: "  one two\n\nthree\tfour  " }),
    );
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockResolvedValue({ id: "doc-9" });

    await POST(uploadRequest(), params(PROJECT_ID));

    expect(addContextDocumentToProject).toHaveBeenCalledWith(
      expect.objectContaining({
        wordCount: 4,
        extractedText: "  one two\n\nthree\tfour  ",
      }),
    );
  });

  it("includes the extraction warning in the response and the saved row only when there is one", async () => {
    const warning =
      "OCR confidence is low (42%). Verify the extracted text before relying on the analysis.";
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(
      preparedUpload({
        mimeType: "image/png",
        method: "tesseract_ocr",
        confidence: 42,
        extractionWarning: warning,
      }),
    );
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockResolvedValue({ id: "doc-9" });

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      documentId: "doc-9",
      extractionMethod: "tesseract_ocr",
      extractionConfidence: 42,
      extractionFailed: false,
      warning,
    });
    expect(addContextDocumentToProject).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionWarning: warning,
        contentType: "image/png",
      }),
    );
  });

  it("omits the warning field when extraction produced none", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    isProjectOwnedByUser.mockResolvedValue(true);
    prepareUpload.mockResolvedValue(preparedUpload());
    storeUploadedFile.mockResolvedValue(storedFile());
    addContextDocumentToProject.mockResolvedValue({ id: "doc-9" });

    const response = await POST(uploadRequest(), params(PROJECT_ID));

    expect(await response.json()).not.toHaveProperty("warning");
  });
});
