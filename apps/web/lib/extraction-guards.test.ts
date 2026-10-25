import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  extractText: vi.fn(),
  getDocumentProxy: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 },
}));
vi.mock("unpdf", () => ({
  extractText: mocks.extractText,
  getDocumentProxy: mocks.getDocumentProxy,
}));

import {
  ExtractedTextContentError,
  ExtractionLimitError,
  ExtractionUnavailableError,
  extractTextFromImage,
  extractTextFromPdf,
  processValidatedFile,
} from "./text-extraction";

beforeEach(() => {
  vi.clearAllMocks();
});

function pdfFixture(
  numPages: number,
  text: string,
  destroy: ReturnType<typeof vi.fn>,
) {
  return {
    numPages,
    destroy,
    getPage: vi
      .fn()
      .mockResolvedValue({
        cleanup: vi.fn(),
        getAnnotations: vi.fn().mockResolvedValue([]),
        getTextContent: vi.fn().mockResolvedValue({ items: [{ str: text }] }),
      }),
  };
}

/** One text item per page, so each page can have its own text layer (or none). */
function pdfPagesFixture(
  pageTexts: string[],
  pageAnnotations: Array<Array<Record<string, unknown>>> = [],
  pageTextItems: Array<Array<{ str: string; transform: number[] }>> = [],
) {
  return {
    numPages: pageTexts.length,
    destroy: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn((pageNumber: number) =>
      Promise.resolve({
        cleanup: vi.fn(),
        getAnnotations: vi
          .fn()
          .mockResolvedValue(pageAnnotations[pageNumber - 1] ?? []),
        getTextContent: vi.fn().mockResolvedValue({
          items: pageTextItems[pageNumber - 1] ?? [
            { str: pageTexts[pageNumber - 1] },
          ],
        }),
      }),
    ),
  };
}

const CLAUSE =
  "The Supplier will deliver the services described in Schedule A within thirty days. ";

describe("extraction resource guards", () => {
  it("rejects excessive PDF page counts before text extraction and releases the parser", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocumentProxy.mockResolvedValue({ numPages: 501, destroy });

    await expect(
      extractTextFromPdf(Buffer.from("%PDF-1.7")),
    ).rejects.toBeInstanceOf(ExtractionLimitError);

    expect(mocks.extractText).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects a PDF whose Flate stream inflates past the budget before PDF.js parses it", async () => {
    const bomb = deflateSync(Buffer.alloc(65 * 1024 * 1024, 0x20));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`,
      ),
      bomb,
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]);

    await expect(
      processValidatedFile(pdf, "application/pdf"),
    ).rejects.toBeInstanceOf(ExtractionLimitError);
    expect(mocks.getDocumentProxy).not.toHaveBeenCalled();
  });

  it("flags a long scanned PDF as scanned even when stray per-page text exceeds 500 characters", async () => {
    // 200 pages of scanner furniture (a Bates stamp per page): sparse enough to be obviously
    // scanned, but well past the absolute 500-character mark that used to suppress detection.
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocumentProxy.mockResolvedValue(
      pdfFixture(200, "BATES-000001 ", destroy),
    );
    mocks.extractText.mockResolvedValue({
      text: "BATES-000001 ".repeat(200),
      totalPages: 200,
    });

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result.text.length).toBeGreaterThan(500);
    expect(result).toMatchObject({ method: "pdf_scanned", confidence: 0 });
  });

  it("still treats a genuinely short, sparse PDF as scanned", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocumentProxy.mockResolvedValue(pdfFixture(1, "Page 1", destroy));
    mocks.extractText.mockResolvedValue({ text: "Page 1", totalPages: 1 });

    await expect(
      extractTextFromPdf(Buffer.from("%PDF-1.7")),
    ).resolves.toMatchObject({
      method: "pdf_scanned",
      confidence: 0,
    });
  });

  it("treats a dense multi-page PDF as parsed", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocumentProxy.mockResolvedValue(
      pdfFixture(20, "This is a real contract clause. ".repeat(10), destroy),
    );
    mocks.extractText.mockResolvedValue({
      text: "This is a real contract clause. ".repeat(200),
      totalPages: 20,
    });

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result).toMatchObject({ method: "pdf_parse", confidence: 100 });
    expect(result.sparseTextPages).toBeUndefined();
  });

  it("names sparse pages of an otherwise digital PDF without changing its text", async () => {
    // A 12-page agreement whose appended schedules (7-9) and signed final page (12) are scans:
    // empty, or carrying only a scanner stamp.
    const pageTexts = Array.from({ length: 12 }, (_, index) =>
      [6, 7, 8, 11].includes(index)
        ? index === 8
          ? "  SCAN-0009  "
          : ""
        : CLAUSE.repeat(4),
    );
    mocks.getDocumentProxy.mockResolvedValue(pdfPagesFixture(pageTexts));

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result).toEqual({
      // The stored text, and therefore every citation offset into it, is unchanged.
      text: pageTexts.join("\n").replace(/\s+/g, " ").trim(),
      method: "pdf_parse",
      confidence: 66,
      sparseTextPages: [7, 8, 9, 12],
    });
  });

  it("never exposes password widget values, but preserves ordinary filled fields", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPagesFixture([CLAUSE.repeat(4)], [
        [
          {
            subtype: "Widget",
            fieldType: "Tx",
            fieldName: "password",
            password: true,
            fieldValue: "PRIVATE-PASSWORD-VALUE",
          },
          {
            subtype: "Widget",
            fieldType: "Tx",
            fieldName: "reference",
            password: false,
            fieldValue: "VISIBLE-REFERENCE-123",
          },
        ],
      ]),
    );

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result.text).not.toContain("PRIVATE-PASSWORD-VALUE");
    expect(result.text).not.toContain("password:");
    expect(result.text).toContain("reference: VISIBLE-REFERENCE-123");
  });

  it("uses displayed labels for selected choice values and falls back for unknown options", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPagesFixture([CLAUSE.repeat(4)], [
        [
          {
            subtype: "Widget",
            fieldType: "Ch",
            fieldName: "paymentMethod",
            fieldValue: ["WIRE", "ACH", "OTHER"],
            options: [
              { exportValue: "WIRE", displayValue: "Wire transfer" },
              { exportValue: "ACH", displayValue: "Bank transfer" },
            ],
          },
        ],
      ]),
    );

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result.text).toContain(
      "paymentMethod: Wire transfer, Bank transfer, OTHER",
    );
    expect(result.text).not.toContain("paymentMethod: WIRE");
  });

  it("does not duplicate a value already in the text layer at the annotation's location", async () => {
    const existingValue = "EXAMPLE-ACCOUNT-123";
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPagesFixture(
        [`${CLAUSE.repeat(4)}Account: ${existingValue}`],
        [
          [
            {
              subtype: "Widget",
              fieldType: "Tx",
              fieldName: "recipientAccount",
              fieldValue: existingValue,
              rect: [40, 650, 430, 674],
            },
            {
              subtype: "FreeText",
              contentsObj: { str: existingValue },
              rect: [40, 650, 430, 674],
            },
            {
              subtype: "Widget",
              fieldType: "Tx",
              fieldName: "newAccount",
              fieldValue: "NEW-ACCOUNT-456",
            },
          ],
        ],
        [
          [
            {
              str: `${CLAUSE.repeat(4)}Account: `,
              transform: [1, 0, 0, 1, 40, 730],
            },
            { str: "EXAMPLE-", transform: [1, 0, 0, 1, 40, 660] },
            { str: "ACCOUNT-123", transform: [1, 0, 0, 1, 95, 660] },
          ],
        ],
      ),
    );

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result.text.split(existingValue)).toHaveLength(2);
    expect(result.text).not.toContain("recipientAccount:");
    expect(result.text).toContain("newAccount: NEW-ACCOUNT-456");
  });

  it.each([1, 26])(
    "does not count metadata or separators for %i fields toward document text density",
    async (fieldCount) => {
      mocks.getDocumentProxy.mockResolvedValue(
        pdfPagesFixture(
          ["", "", ""],
          Array.from({ length: 3 }, () =>
            Array.from({ length: fieldCount }, () => ({
              subtype: "Widget",
              fieldType: "Tx",
              fieldName:
                "Long internal field name that is not visible on the scanned page",
              fieldValue: "X",
            })),
          ),
        ),
      );

      const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

      expect(result.text).toContain("Long internal field name");
      expect(result).toMatchObject({ method: "pdf_scanned", confidence: 0 });
    },
  );

  it("counts substantial annotation values toward text density", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPagesFixture(
        ["", "", ""],
        Array.from({ length: 3 }, () => [
          {
            subtype: "FreeText",
            contentsObj: { str: CLAUSE.repeat(4) },
          },
        ]),
      ),
    );

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result).toMatchObject({ method: "pdf_parse", confidence: 100 });
    expect(result.sparseTextPages).toBeUndefined();
  });

  it("rejects a NUL character that the PDF parser emits instead of returning it for storage", async () => {
    const fixture = pdfPagesFixture([
      CLAUSE.repeat(4),
      `${CLAUSE}Notice period:\u000030 days.`,
    ]);
    mocks.getDocumentProxy.mockResolvedValue(fixture);

    await expect(
      processValidatedFile(Buffer.from("%PDF-1.7"), "application/pdf"),
    ).rejects.toBeInstanceOf(ExtractedTextContentError);
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });

  it("counts non-whitespace characters per page against the 20-character threshold", async () => {
    const letters = "abcdefghijklmnopqrst";
    // 19 characters padded with whitespace still count as sparse; 20 do not.
    const nineteen = letters.slice(0, 19).split("").join(" \n\t");
    const twenty = letters.split("").join(" ");
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPagesFixture([CLAUSE.repeat(6), nineteen, twenty]),
    );

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result).toMatchObject({
      method: "pdf_parse",
      confidence: 66,
      sparseTextPages: [2],
    });
  });

  it("keeps the whole-document scanned result when most pages have no text", async () => {
    mocks.getDocumentProxy.mockResolvedValue(
      pdfPagesFixture(["", CLAUSE, "", "", ""]),
    );

    const result = await extractTextFromPdf(Buffer.from("%PDF-1.7"));

    expect(result).toEqual({
      text: CLAUSE.trim(),
      method: "pdf_scanned",
      confidence: 0,
    });
  });

  it("stops before the next PDF page when the text budget is exhausted", async () => {
    const fixture = pdfFixture(10, "x".repeat(2_000_001), vi.fn());
    mocks.getDocumentProxy.mockResolvedValue(fixture);
    await expect(
      extractTextFromPdf(Buffer.from("%PDF-1.7")),
    ).rejects.toBeInstanceOf(ExtractionLimitError);
    expect(fixture.getPage).toHaveBeenCalledOnce();
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });

  it("terminates and replaces a cached OCR worker after recognition fails", async () => {
    let releaseHeldRecognition!: (value: {
      data: { text: string; confidence: number };
    }) => void;
    const heldRecognition = new Promise<{
      data: { text: string; confidence: number };
    }>((resolve) => {
      releaseHeldRecognition = resolve;
    });
    const firstWorker = {
      recognize: vi.fn().mockRejectedValue(new Error("worker crashed")),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    const secondWorker = {
      recognize: vi
        .fn()
        .mockResolvedValueOnce({
          data: { text: "Recovered text", confidence: 93 },
        })
        .mockReturnValueOnce(heldRecognition)
        .mockResolvedValue({
          data: { text: "Queued text", confidence: 91 },
        }),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createWorker
      .mockResolvedValueOnce(firstWorker)
      .mockResolvedValueOnce(secondWorker);

    await expect(
      extractTextFromImage(Buffer.from("bad image")),
    ).rejects.toThrow(/worker crashed/i);
    const recovered = await extractTextFromImage(Buffer.from("good image"));

    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({
      text: "Recovered text",
      confidence: 93,
      method: "tesseract_ocr",
    });

    const activeJob = extractTextFromImage(Buffer.from("slow image"));
    await vi.waitFor(() => {
      expect(secondWorker.recognize).toHaveBeenCalledTimes(2);
    });
    const queuedJob = extractTextFromImage(Buffer.from("queued image"));

    await expect(
      extractTextFromImage(Buffer.from("excess image")),
    ).rejects.toBeInstanceOf(ExtractionUnavailableError);

    releaseHeldRecognition({
      data: { text: "Slow text", confidence: 92 },
    });
    await expect(activeJob).resolves.toMatchObject({ text: "Slow text" });
    await expect(queuedJob).resolves.toMatchObject({ text: "Queued text" });
  });
});
