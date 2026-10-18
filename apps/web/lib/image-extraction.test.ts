import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createWorker: vi.fn() }));

vi.mock("tesseract.js", () => ({
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 },
}));

const UNAVAILABLE =
  "Image text extraction is unavailable right now. Please try again shortly.";
const image = Buffer.from("image bytes");
const threads: Worker[] = [];

/** A real worker thread, started the way tesseract.js starts one: inside createWorker(). */
function spawnThread(source: string) {
  const thread = new Worker(source, { eval: true });
  threads.push(thread);
  return thread;
}

function fakeWorker(text: string) {
  return {
    recognize: vi.fn().mockResolvedValue({ data: { text, confidence: 91 } }),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

// Each test gets a fresh module instance, so no cached OCR engine carries over.
async function loadExtraction() {
  vi.resetModules();
  return import("./text-extraction");
}

beforeEach(() => {
  mocks.createWorker.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.doUnmock("@tesseract.js-data/eng");
  vi.restoreAllMocks();
  await Promise.all(threads.splice(0).map((thread) => thread.terminate()));
});

describe("image OCR engine failures", () => {
  it("starts tesseract.js with the bundled model, no disk cache and the traced core builds", async () => {
    mocks.createWorker.mockResolvedValueOnce(fakeWorker("Clause"));
    const { extractTextFromImage } = await loadExtraction();

    await expect(extractTextFromImage(image)).resolves.toEqual({
      text: "Clause",
      method: "tesseract_ocr",
      confidence: 91,
    });
    expect(mocks.createWorker).toHaveBeenCalledWith(
      "eng",
      1,
      expect.objectContaining({
        workerPath: expect.stringMatching(
          /worker-script[\\/]node[\\/]index\.js$/,
        ),
        langPath: expect.stringMatching(
          /@tesseract\.js-data[\\/]eng[\\/]4\.0\.0_best_int$/,
        ),
        cacheMethod: "none",
        gzip: true,
        legacyCore: true,
        errorHandler: expect.any(Function),
      }),
    );
  });

  it("rejects instead of crashing the process when the worker thread fails to start", async () => {
    mocks.createWorker
      .mockImplementationOnce(() => {
        // tesseract.js watches its thread only through `onerror`, which Node never calls, and
        // its createWorker() promise then never settles.
        spawnThread(
          "throw new Error('Cannot find module worker-script/node/index.js')",
        );
        return new Promise(() => {});
      })
      .mockResolvedValueOnce(fakeWorker("Recovered"));
    const { extractTextFromImage, ExtractionUnavailableError } =
      await loadExtraction();

    const failure = extractTextFromImage(image);
    await expect(failure).rejects.toBeInstanceOf(ExtractionUnavailableError);
    await expect(failure).rejects.toThrow(UNAVAILABLE);
    expect(console.error).toHaveBeenCalledWith(
      "OCR worker thread failed:",
      expect.objectContaining({
        message: expect.stringMatching(/Cannot find module/),
      }),
    );

    // The failed engine was not cached: the next upload starts a new worker.
    await expect(extractTextFromImage(image)).resolves.toMatchObject({
      text: "Recovered",
    });
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
  });

  it("fails fast when the worker reports that the model or core could not load", async () => {
    mocks.createWorker.mockImplementationOnce(
      (
        _language,
        _oem,
        options: { errorHandler: (error: unknown) => void },
      ) => {
        // A failed language load reaches errorHandler but leaves createWorker() pending.
        setImmediate(() =>
          options.errorHandler(
            "Error: ENOENT: no such file or directory, open '/var/task/eng.traineddata.gz'",
          ),
        );
        return new Promise(() => {});
      },
    );
    const { extractTextFromImage, ExtractionUnavailableError } =
      await loadExtraction();

    const failure = extractTextFromImage(image);
    await expect(failure).rejects.toBeInstanceOf(ExtractionUnavailableError);
    // The cause is logged, never shown to the uploader.
    await expect(failure).rejects.toThrow(UNAVAILABLE);
  });

  it("ends a recognition at once when the worker thread dies mid-job", async () => {
    let thread!: Worker;
    mocks.createWorker
      .mockImplementationOnce(async () => {
        thread = spawnThread(
          "require('node:worker_threads').parentPort.once('message', () => { throw new Error('RuntimeError: memory access out of bounds'); });",
        );
        return {
          recognize: vi.fn(() => {
            thread.postMessage("recognize");
            return new Promise(() => {});
          }),
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      })
      .mockResolvedValueOnce(fakeWorker("Second engine"));
    const { extractTextFromImage, ExtractionUnavailableError } =
      await loadExtraction();

    // Without the thread watch this would wait for the 90-second recognition timeout.
    await expect(extractTextFromImage(image)).rejects.toBeInstanceOf(
      ExtractionUnavailableError,
    );
    await expect(extractTextFromImage(image)).resolves.toMatchObject({
      text: "Second engine",
    });
  });

  it("drops a cached engine whose thread exits while idle", async () => {
    mocks.createWorker
      .mockImplementationOnce(async () => {
        spawnThread("setInterval(() => {}, 1_000);");
        return fakeWorker("First engine");
      })
      .mockResolvedValueOnce(fakeWorker("Second engine"));
    const { extractTextFromImage } = await loadExtraction();

    await expect(extractTextFromImage(image)).resolves.toMatchObject({
      text: "First engine",
    });
    await threads[0]!.terminate();
    await new Promise(setImmediate);

    await expect(extractTextFromImage(image)).resolves.toMatchObject({
      text: "Second engine",
    });
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
  });

  it("reports missing OCR files as unavailable without starting a worker", async () => {
    vi.doMock("@tesseract.js-data/eng", () => ({
      default: { code: "eng", gzip: true, langPath: "/nonexistent/eng/4.0.0" },
    }));
    const { extractTextFromImage, ExtractionUnavailableError } =
      await loadExtraction();

    const failure = extractTextFromImage(image);
    await expect(failure).rejects.toBeInstanceOf(ExtractionUnavailableError);
    await expect(failure).rejects.toThrow(UNAVAILABLE);
    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "OCR worker assets are unavailable:",
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});
