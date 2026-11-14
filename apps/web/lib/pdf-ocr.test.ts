import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawRaster } from "./png-encode";

// Scanned-page OCR inside extractTextFromPdf, with the PDF parser, the page rasters and the OCR
// engine mocked. The real engine and parser run in pdf-extraction.integration.test.ts.

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  getDocumentProxy: vi.fn(),
  largestPageRaster: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 },
}));
vi.mock("unpdf", () => ({ getDocumentProxy: mocks.getDocumentProxy }));
vi.mock("@/lib/pdf-rasters", () => ({
  largestPageRaster: mocks.largestPageRaster,
}));

const CLAUSE =
  "The Supplier will deliver the services described in Schedule A within thirty days. ";
const PAGE = { width: 1275, height: 1650 };

type Recognition = { data: { text: string; confidence: number } };

function pdfPages(pageTexts: string[]) {
  return {
    numPages: pageTexts.length,
    destroy: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn((pageNumber: number) =>
      Promise.resolve({
        cleanup: vi.fn(),
        getAnnotations: vi.fn().mockResolvedValue([]),
        getTextContent: vi.fn().mockResolvedValue({
          items: [{ str: pageTexts[pageNumber - 1] }],
        }),
      }),
    ),
  };
}

/** Give these pages a raster of this size; other pages paint none. */
function rasters(sizes: Record<number, { width: number; height: number }>) {
  mocks.largestPageRaster.mockImplementation(
    async (
      _pdf: unknown,
      pageNumber: number,
      accept: (size: { width: number; height: number }) => boolean,
    ): Promise<RawRaster | null> => {
      const size = sizes[pageNumber];
      if (!size || !accept(size)) return null;
      // The size check is what matters here; a small stand-in keeps the PNG encoding cheap.
      return {
        data: new Uint8Array(16).fill(255),
        width: 4,
        height: 4,
        channels: 1,
      };
    },
  );
}

function fakeWorker(
  ...results: Array<Recognition | Promise<Recognition> | Error>
) {
  const recognize = vi.fn();
  for (const result of results) {
    if (result instanceof Error) recognize.mockRejectedValueOnce(result);
    else recognize.mockReturnValueOnce(Promise.resolve(result));
  }
  return { recognize, terminate: vi.fn().mockResolvedValue(undefined) };
}

const read = (text: string, confidence = 90): Recognition => ({
  data: { text, confidence },
});

// Each test gets a fresh module instance, so no cached OCR engine or queue carries over.
async function loadExtraction() {
  vi.resetModules();
  return import("./text-extraction");
}

beforeEach(() => {
  mocks.createWorker.mockReset();
  mocks.getDocumentProxy.mockReset();
  mocks.largestPageRaster.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanned PDF page OCR", () => {
  it("reads every page of a scanned PDF in page order with one engine start", async () => {
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", "", ""]));
    rasters({ 1: PAGE, 2: PAGE, 3: PAGE });
    const worker = fakeWorker(
      read("Page one terms.", 90),
      read("Page two terms.", 80),
      read("Page three terms.", 70),
    );
    mocks.createWorker.mockResolvedValueOnce(worker);
    const { extractTextFromPdf } = await loadExtraction();

    await expect(extractTextFromPdf(Buffer.from("%PDF-1.7"))).resolves.toEqual({
      text: "Page one terms. Page two terms. Page three terms.",
      method: "pdf_ocr",
      confidence: 99,
      ocrPages: [1, 2, 3],
      ocrConfidence: 80,
    });
    expect(mocks.createWorker).toHaveBeenCalledOnce();
    expect(worker.recognize).toHaveBeenCalledTimes(3);
    // Each recognition gets a PNG file, which is what tesseract.js reads.
    const [image] = worker.recognize.mock.calls[0]!;
    expect(Buffer.isBuffer(image)).toBe(true);
    expect(image.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("OCRs only the sparse pages of a text PDF and keeps the text layer of the others", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPages([CLAUSE.repeat(3), "SCAN-0002", CLAUSE.repeat(3)]),
    );
    rasters({ 1: PAGE, 2: PAGE, 3: PAGE });
    const worker = fakeWorker(read("Schedule B. Fees: 2,000 USD monthly."));
    mocks.createWorker.mockResolvedValueOnce(worker);
    const { extractTextFromPdf } = await loadExtraction();

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    // Page 2's own selectable text ("SCAN-0002") is kept ahead of its OCR text.
    expect(result).toEqual({
      text: [
        CLAUSE.repeat(3).trim(),
        "SCAN-0002 Schedule B. Fees: 2,000 USD monthly.",
        CLAUSE.repeat(3).trim(),
      ].join(" "),
      method: "pdf_ocr",
      confidence: 99,
      ocrPages: [2],
      ocrConfidence: 90,
    });
    expect(mocks.largestPageRaster).toHaveBeenCalledOnce();
    expect(mocks.largestPageRaster).toHaveBeenCalledWith(
      expect.anything(),
      2,
      expect.any(Function),
      expect.anything(),
    );
  });

  it.each([
    ["below the minimum size", { width: 299, height: 1650 }],
    ["above 25,000,000 pixels", { width: 5_001, height: 5_000 }],
  ])("skips a raster %s and leaves its page flagged", async (_label, size) => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPages([CLAUSE.repeat(3), "", CLAUSE.repeat(3)]),
    );
    rasters({ 2: size });
    const { extractTextFromPdf } = await loadExtraction();

    await expect(extractTextFromPdf(Buffer.from("%PDF-1.7"))).resolves.toEqual({
      text: [CLAUSE.repeat(3).trim(), CLAUSE.repeat(3).trim()].join(" "),
      method: "pdf_parse",
      confidence: 66,
      sparseTextPages: [2],
    });
    // No usable raster, so the OCR engine is never started.
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("accepts rasters at the minimum size and at the pixel limit", async () => {
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", ""]));
    rasters({
      1: { width: 300, height: 300 },
      2: { width: 5_000, height: 5_000 },
    });
    mocks.createWorker.mockResolvedValueOnce(
      fakeWorker(read("First page."), read("Second page.")),
    );
    const { extractTextFromPdf } = await loadExtraction();

    await expect(
      extractTextFromPdf(Buffer.from("%PDF-1.7")),
    ).resolves.toMatchObject({ method: "pdf_ocr", ocrPages: [1, 2] });
  });

  it("stops at the page cap and leaves the later pages flagged", async () => {
    const { MAX_PDF_OCR_PAGES } = await loadExtraction();
    const pageCount = MAX_PDF_OCR_PAGES + 2;
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPages(Array.from({ length: pageCount }, () => "")),
    );
    rasters(
      Object.fromEntries(
        Array.from({ length: pageCount }, (_, i) => [i + 1, PAGE]),
      ),
    );
    const worker = fakeWorker(
      ...Array.from({ length: pageCount }, (_, i) => read(`Page ${i + 1}.`)),
    );
    mocks.createWorker.mockResolvedValueOnce(worker);
    const { extractTextFromPdf } = await loadExtraction();

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(worker.recognize).toHaveBeenCalledTimes(MAX_PDF_OCR_PAGES);
    expect(result.ocrPages).toEqual(
      Array.from({ length: MAX_PDF_OCR_PAGES }, (_, i) => i + 1),
    );
    expect(result.sparseTextPages).toEqual([11, 12]);
    expect(result).toMatchObject({ method: "pdf_ocr", confidence: 83 });
  });

  it("stops when the recognition budget is spent and leaves the later pages flagged", async () => {
    const { PDF_OCR_BUDGET_MS } = await loadExtraction();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", "", ""]));
    rasters({ 1: PAGE, 2: PAGE, 3: PAGE });
    const worker = fakeWorker();
    // Each page takes 60% of the budget: the second still starts, the third does not.
    worker.recognize.mockImplementation(async () => {
      now += PDF_OCR_BUDGET_MS * 0.6;
      return read("Read page.");
    });
    mocks.createWorker.mockResolvedValueOnce(worker);
    const { extractTextFromPdf } = await loadExtraction();

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(worker.recognize).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      method: "pdf_ocr",
      ocrPages: [1, 2],
      sparseTextPages: [3],
    });
  });

  it("ends a recognition that outlasts the remaining budget and keeps the pages read before it", async () => {
    const { PDF_OCR_BUDGET_MS } = await loadExtraction();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", "", ""]));
    rasters({ 1: PAGE, 2: PAGE, 3: PAGE });
    const worker = fakeWorker();
    worker.recognize
      .mockImplementationOnce(async () => {
        // Leave 20 ms of the budget for page 2, whose recognition never finishes.
        now += PDF_OCR_BUDGET_MS - 20;
        return read("First page.");
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    mocks.createWorker.mockResolvedValueOnce(worker);
    const { extractTextFromPdf } = await loadExtraction();

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result).toMatchObject({
      text: "First page.",
      method: "pdf_ocr",
      ocrPages: [1],
      sparseTextPages: [2, 3],
    });
    // The busy worker cannot be reused, so it is terminated.
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("stops waiting for a page image that outlasts the remaining budget", async () => {
    const { PDF_OCR_BUDGET_MS } = await loadExtraction();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPages([CLAUSE.repeat(4), "", "", "", CLAUSE.repeat(4)]),
    );
    mocks.largestPageRaster
      .mockImplementationOnce(async () => {
        // Page 2 paints no image but leaves only 20 ms of the budget.
        now += PDF_OCR_BUDGET_MS - 20;
        return null;
      })
      // Page 3's images never finish decoding; only the signal ends the wait.
      .mockImplementationOnce(
        (_pdf: unknown, _page: number, _accept: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          ),
      );
    const { extractTextFromPdf } = await loadExtraction();

    await expect(extractTextFromPdf(Buffer.from("%PDF-1.7"))).resolves.toEqual({
      text: [CLAUSE.repeat(4).trim(), CLAUSE.repeat(4).trim()].join(" "),
      method: "pdf_parse",
      confidence: 40,
      sparseTextPages: [2, 3, 4],
    });
    // Page 4 is not tried once the budget is spent.
    expect(mocks.largestPageRaster).toHaveBeenCalledTimes(2);
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("keeps the rest of the result when OCR fails on a page", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPages([CLAUSE.repeat(4), "", "", CLAUSE.repeat(4), CLAUSE.repeat(4)]),
    );
    rasters({ 2: PAGE, 3: PAGE });
    const worker = fakeWorker(
      read("Signed by both parties."),
      new Error("RuntimeError: memory access out of bounds"),
    );
    mocks.createWorker
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce(fakeWorker(read("Next upload.")));
    const { extractTextFromPdf, extractTextFromImage } = await loadExtraction();

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result).toEqual({
      text: [
        CLAUSE.repeat(4).trim(),
        "Signed by both parties.",
        CLAUSE.repeat(4).trim(),
        CLAUSE.repeat(4).trim(),
      ].join(" "),
      method: "pdf_ocr",
      confidence: 80,
      sparseTextPages: [3],
      ocrPages: [2],
      ocrConfidence: 90,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    // The failed engine is not reused: the next job starts a fresh one.
    await expect(
      extractTextFromImage(Buffer.from("image")),
    ).resolves.toMatchObject({ text: "Next upload." });
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
  });

  it("returns today's scanned result when the OCR engine cannot start", async () => {
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", "SCAN", ""]));
    rasters({ 1: PAGE, 2: PAGE, 3: PAGE });
    mocks.createWorker.mockRejectedValueOnce(new Error("wasm failed to load"));
    const { extractTextFromPdf } = await loadExtraction();

    await expect(extractTextFromPdf(Buffer.from("%PDF-1.7"))).resolves.toEqual({
      text: "SCAN",
      method: "pdf_scanned",
      confidence: 0,
    });
  });

  it("leaves pages flagged when a page image cannot be read", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPages([CLAUSE.repeat(3), "", CLAUSE.repeat(3)]),
    );
    mocks.largestPageRaster.mockRejectedValue(new Error("JBIG2 decode failed"));
    const { extractTextFromPdf } = await loadExtraction();

    await expect(
      extractTextFromPdf(Buffer.from("%PDF-1.7")),
    ).resolves.toMatchObject({ method: "pdf_parse", sparseTextPages: [2] });
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("leaves an OCR'd page that yields no text flagged", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPages([CLAUSE.repeat(3), "", CLAUSE.repeat(3)]),
    );
    rasters({ 2: PAGE });
    mocks.createWorker.mockResolvedValueOnce(fakeWorker(read("  \n ", 0)));
    const { extractTextFromPdf } = await loadExtraction();

    await expect(
      extractTextFromPdf(Buffer.from("%PDF-1.7")),
    ).resolves.toMatchObject({ method: "pdf_parse", sparseTextPages: [2] });
  });

  it("takes one OCR queue slot for all of a PDF's pages", async () => {
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", ""]));
    rasters({ 1: PAGE, 2: PAGE });
    let finishFirstPage!: (value: Recognition) => void;
    const worker = fakeWorker(
      new Promise<Recognition>((resolve) => {
        finishFirstPage = resolve;
      }),
      read("PDF page two."),
      read("Image text."),
    );
    mocks.createWorker.mockResolvedValueOnce(worker);
    const {
      extractTextFromPdf,
      extractTextFromImage,
      ExtractionUnavailableError,
    } = await loadExtraction();

    const pdfJob = extractTextFromPdf(Buffer.from("%PDF-1.7"));
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
    // One active job (the PDF) plus one waiter is the limit.
    const imageJob = extractTextFromImage(Buffer.from("image"));
    await expect(
      extractTextFromImage(Buffer.from("excess image")),
    ).rejects.toBeInstanceOf(ExtractionUnavailableError);

    finishFirstPage(read("PDF page one."));
    await expect(pdfJob).resolves.toMatchObject({
      text: "PDF page one. PDF page two.",
      ocrPages: [1, 2],
    });
    // The image waited for both of the PDF's pages rather than running between them.
    await expect(imageJob).resolves.toMatchObject({ text: "Image text." });
    expect(worker.recognize).toHaveBeenCalledTimes(3);
    expect(mocks.createWorker).toHaveBeenCalledOnce();
  });

  it("leaves pages flagged without waiting when the OCR queue is full", async () => {
    let finishImage!: (value: Recognition) => void;
    const worker = fakeWorker(
      new Promise<Recognition>((resolve) => {
        finishImage = resolve;
      }),
      read("Queued image."),
    );
    mocks.createWorker.mockResolvedValueOnce(worker);
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", ""]));
    rasters({ 1: PAGE, 2: PAGE });
    const { extractTextFromPdf, extractTextFromImage } = await loadExtraction();

    const active = extractTextFromImage(Buffer.from("active"));
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
    const queued = extractTextFromImage(Buffer.from("queued"));

    await expect(extractTextFromPdf(Buffer.from("%PDF-1.7"))).resolves.toEqual({
      text: "",
      method: "pdf_scanned",
      confidence: 0,
    });

    finishImage(read("Active image."));
    await expect(active).resolves.toMatchObject({ text: "Active image." });
    await expect(queued).resolves.toMatchObject({ text: "Queued image." });
  });

  it("stops and rejects when the caller aborts during recognition", async () => {
    mocks.getDocumentProxy.mockResolvedValue(pdfPages(["", ""]));
    rasters({ 1: PAGE, 2: PAGE });
    const worker = fakeWorker(new Promise<Recognition>(() => {}));
    mocks.createWorker.mockResolvedValueOnce(worker);
    const { extractTextFromPdf } = await loadExtraction();
    const controller = new AbortController();

    const job = extractTextFromPdf(Buffer.from("%PDF-1.7"), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
    controller.abort();

    await expect(job).rejects.toThrow(/Failed to parse PDF/);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
