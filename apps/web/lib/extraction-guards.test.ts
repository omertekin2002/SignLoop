import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  extractText: vi.fn(),
  getDocumentProxy: vi.fn(),
}));

vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker }));
vi.mock("unpdf", () => ({
  extractText: mocks.extractText,
  getDocumentProxy: mocks.getDocumentProxy,
}));

import {
  ExtractionLimitError,
  ExtractionUnavailableError,
  extractTextFromImage,
  extractTextFromPdf,
} from "./text-extraction";

beforeEach(() => {
  vi.clearAllMocks();
});

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
