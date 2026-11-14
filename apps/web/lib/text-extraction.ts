import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Worker as NodeWorker } from "node:worker_threads";
import {
  ExtractionLimitError,
  MAX_EXTRACTED_TEXT_LENGTH,
  MAX_IMAGE_PIXELS,
  validateImageDimensions,
  validateDocxExpansion,
  validatePdfExpansion,
} from "@/lib/extraction-limits";
export { ExtractionLimitError } from "@/lib/extraction-limits";
import {
  ENGLISH_MODEL_DIRECTORY,
  ENGLISH_MODEL_FILE,
  TESSERACT_CORE_BUILDS,
} from "@/lib/ocr-assets";
import type { createWorker } from "tesseract.js";
import type WordExtractor from "word-extractor";
import { getErrorMessage } from "@/lib/utils";
import { withAbort } from "@repo/chat-engine/bounded-response";
import { isOleCompoundFile, validateOleCompoundFile } from "@/lib/ole-guard";
import { largestPageRaster, type PdfDocumentProxy } from "@/lib/pdf-rasters";
import { encodePng } from "@/lib/png-encode";
import {
  DOC_MIME_TYPE,
  DOCX_MIME_TYPE,
  hasPrefix,
  PDF_MIME_TYPE,
  TEXT_MIME_TYPE,
  validateFileSignature,
  validateMimeType,
} from "@/lib/file-types";
export {
  DECLARABLE_UPLOAD_MIME_TYPES,
  validateFileSignature,
  validateMimeType,
} from "@/lib/file-types";

const MIN_TEXT_DENSITY = 50; // Minimum characters per page for non-scanned PDF
// At or below this page count a sparse PDF may still be a legitimately short document, so the
// absolute-length check applies. Above it, low density is decisive on its own.
const SHORT_DOCUMENT_PAGE_COUNT = 2;
// A page with fewer non-whitespace characters than this is flagged as sparse: it may be blank, a
// short cover page ("EXHIBIT A"), or, typically for appended schedules and signature pages, a
// scanned image carrying at most a stamp or page number. Text alone cannot tell these apart, so
// the flag is a prompt to check the page, not a claim that its text was dropped.
const MIN_PAGE_TEXT_CHARACTERS = 20;
const MAX_PDF_PAGES = 500;
const MAX_PENDING_OCR_JOBS = 2;
const OCR_WORKER_INIT_TIMEOUT_MS = 60_000;
const OCR_RECOGNITION_TIMEOUT_MS = 90_000;
const OCR_LANGUAGE = "eng";
// Scanned PDF pages are read within the parse function's 150 s deadline: at most this many
// recognitions per PDF, within this budget for reading page images and recognizing them. Waiting
// for the shared worker (PDF_OCR_QUEUE_WAIT_MS) and starting it (OCR_WORKER_INIT_TIMEOUT_MS) are
// bounded separately: 10 + 60 + 70 s leaves room for the text pass.
export const MAX_PDF_OCR_PAGES = 10;
export const PDF_OCR_BUDGET_MS = 70_000;
const PDF_OCR_QUEUE_WAIT_MS = 10_000;
// Smaller rasters are stamps, logos or placeholders rather than a page of text.
const MIN_PDF_OCR_RASTER_SIDE = 300;
const OCR_UNAVAILABLE_MESSAGE =
  "Image text extraction is unavailable right now. Please try again shortly.";

// The three extractor libraries (unpdf, tesseract.js, word-extractor) are heavy, so each is
// imported lazily inside the extractor that needs it — a PDF upload no longer pulls in the OCR
// wasm or the Word parser, and validate-only callers load none of them.

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

/** A started tesseract.js worker. `failed` rejects if its thread dies or startup fails. */
type OcrEngine = {
  worker: TesseractWorker;
  failed: Promise<never>;
  terminate(): Promise<void>;
};

// Reuse a single OCR engine across requests so we don't re-spin a worker thread and reload the
// English language model on every image upload (the dominant cost in tesseract.js). An engine
// that fails to start or whose thread dies is dropped so the next call starts a fresh one.
let ocrEnginePromise: Promise<OcrEngine> | null = null;
let ocrQueue: Promise<void> = Promise.resolve();
let pendingOcrJobs = 0;

/** Wait for the shared OCR worker and hold it until the returned release is called. */
async function acquireOcrSlot(signal: AbortSignal): Promise<() => void> {
  const previous = ocrQueue;
  let release!: () => void;
  ocrQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await withAbort(previous, signal);
  } catch (error) {
    // A canceled waiter must not unlock the worker while its predecessor is still running.
    void previous.then(release, release);
    throw error;
  }
  return release;
}

async function runSerializedOcr<T>(
  task: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const release = await acquireOcrSlot(signal);
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * Locate the OCR worker script, core builds and English model where they are deployed.
 * tesseract.js and @tesseract.js-data/eng stay unbundled (serverExternalPackages in
 * next.config.js), so paths they derive from their own `__dirname` are runtime paths; a bundled
 * copy would carry build-machine paths instead. Every file is checked here because a missing
 * worker script or WebAssembly file otherwise fails inside the worker thread, not as a rejection.
 */
async function resolveOcrAssets(): Promise<{
  workerPath: string;
  langPath: string;
}> {
  const [{ default: workerDefaults }, { default: englishData }] =
    await Promise.all([
      import("tesseract.js/src/worker/node/defaultOptions.js"),
      import("@tesseract.js-data/eng"),
    ]);
  const { workerPath } = workerDefaults;
  // The package's entry point names its legacy-engine directory; the model sits beside it.
  const langPath = path.join(
    path.dirname(englishData.langPath),
    ENGLISH_MODEL_DIRECTORY,
  );
  // The worker requires its core build relative to its own location, so resolve from there.
  const requireFromWorker = createRequire(workerPath);
  const files = [workerPath, path.join(langPath, ENGLISH_MODEL_FILE)];
  // The worker picks one of these at runtime (see lib/ocr-assets.js); all of them are traced.
  for (const build of TESSERACT_CORE_BUILDS) {
    const script = requireFromWorker.resolve(`tesseract.js-core/${build}.js`);
    files.push(script, script.replace(/\.js$/, ".wasm"));
  }
  await Promise.all(files.map((file) => access(file, fsConstants.R_OK)));
  return { workerPath, langPath };
}

async function startOcrEngine(): Promise<OcrEngine> {
  let reportFailure!: (error: ExtractionUnavailableError) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    reportFailure = reject;
  });
  // A recognition races `failed`, but an idle engine can also die with nobody waiting on it.
  failed.catch(() => {});
  let failure: ExtractionUnavailableError | null = null;
  let stopping = false;
  const fail = (reason: string, cause?: unknown) => {
    if (failure) return failure;
    const error = new ExtractionUnavailableError(OCR_UNAVAILABLE_MESSAGE, {
      cause,
    });
    failure = error;
    if (!stopping) console.error(`OCR worker ${reason}:`, cause);
    reportFailure(error);
    return error;
  };

  let tesseract: typeof import("tesseract.js");
  let assets: Awaited<ReturnType<typeof resolveOcrAssets>>;
  try {
    [tesseract, assets] = await Promise.all([
      import("tesseract.js"),
      resolveOcrAssets(),
    ]);
  } catch (error: unknown) {
    throw fail("assets are unavailable", error);
  }

  let thread: NodeWorker | undefined;
  const watch = (spawned: NodeWorker) => {
    thread = spawned;
    spawned.on("error", (error) => fail("thread failed", error));
    spawned.once("exit", (code) => fail(`thread exited with code ${code}`));
    // An idle cached engine must not keep a process (a script or test run) alive. Work in
    // progress still does, through the startup and recognition timeouts.
    spawned.unref();
  };
  // tesseract.js spawns its worker thread synchronously inside createWorker() but watches it only
  // through a browser-style `onerror` property, which Node ignores: a failed spawn or a crashed
  // thread would be an uncaught exception in this process. Node announces each new thread from a
  // nextTick callback queued by the Worker constructor, so a listener added from a callback queued
  // just before createWorker() skips earlier threads and receives this one. The second callback
  // removes the listener if no thread was spawned.
  process.nextTick(() => process.once("worker", watch));
  let started = false;
  let creation: Promise<TesseractWorker>;
  try {
    creation = tesseract.createWorker(OCR_LANGUAGE, tesseract.OEM.LSTM_ONLY, {
      workerPath: assets.workerPath,
      // Pins the core to the builds traced for deployment (TESSERACT_CORE_BUILDS).
      legacyCore: true,
      langPath: assets.langPath,
      gzip: true,
      // The default cache reads and writes traineddata in the working directory, which is
      // read-only on Vercel; read the bundled model directly instead.
      cacheMethod: "none",
      // Without a handler tesseract.js rethrows worker-reported failures inside its message
      // listener (another uncaught exception), and a failed language load or initialization
      // leaves createWorker() pending. Later reports also reject the recognize() call that
      // caused them, which the caller handles.
      errorHandler: (error: unknown) => {
        if (!started) fail("could not start", error);
      },
    });
  } catch (error: unknown) {
    throw fail("could not start", error);
  } finally {
    process.nextTick(() => process.off("worker", watch));
  }
  // Settle tesseract.js's own promise quietly when `failed` decides the race below.
  creation.catch(() => {});

  let worker: TesseractWorker;
  try {
    worker = await Promise.race([creation, failed]);
  } catch (error: unknown) {
    const startupFailure = fail("could not start", error);
    stopping = true;
    void thread?.terminate().catch(() => {});
    void creation
      .then(
        (late) => late.terminate(),
        () => {},
      )
      .catch(() => {});
    throw startupFailure;
  }
  started = true;
  // The thread announcement is the primary hook; tesseract.js also exposes its handle.
  const handle = (worker as TesseractWorker & { worker?: NodeWorker }).worker;
  if (handle && handle !== thread) watch(handle);
  return {
    worker,
    failed,
    terminate: async () => {
      stopping = true;
      await worker.terminate();
    },
  };
}

function getOcrEngine(): Promise<OcrEngine> {
  if (!ocrEnginePromise) {
    const enginePromise = startOcrEngine().then(
      (engine) => {
        // A crashed engine must not stay cached; the next request starts a fresh one.
        engine.failed.catch(() => {
          if (ocrEnginePromise === enginePromise) ocrEnginePromise = null;
        });
        return engine;
      },
      (error: unknown) => {
        // A timed-out initialization may already have been replaced by a new engine promise.
        // Only clear the cache if this failing promise is still the active one.
        if (ocrEnginePromise === enginePromise) ocrEnginePromise = null;
        throw error;
      },
    );
    ocrEnginePromise = enginePromise;
  }
  return ocrEnginePromise;
}

/**
 * The cached engine for an OCR job that already holds the queue slot, waiting at most
 * OCR_WORKER_INIT_TIMEOUT_MS for it to start.
 */
async function startOcrJobEngine(signal: AbortSignal): Promise<OcrEngine> {
  const enginePromise = getOcrEngine();
  let engineInitTimeout: ReturnType<typeof setTimeout> | undefined;
  let initTimedOut = false;
  try {
    return await withAbort(
      Promise.race([
        enginePromise,
        new Promise<never>((_resolve, reject) => {
          engineInitTimeout = setTimeout(() => {
            initTimedOut = true;
            reject(
              new ExtractionUnavailableError(
                "Image text extraction could not start. Please try again shortly.",
              ),
            );
          }, OCR_WORKER_INIT_TIMEOUT_MS);
        }),
      ]),
      signal,
    );
  } catch (error: unknown) {
    if (initTimedOut || signal.aborted) {
      // A late engine must not remain orphaned or become the cached engine after this
      // request has already failed. Terminate it asynchronously when startup eventually ends;
      // a startup failure is already logged and uncached by getOcrEngine.
      if (ocrEnginePromise === enginePromise) ocrEnginePromise = null;
      void enginePromise
        .then(
          (lateEngine) => lateEngine.terminate(),
          () => {},
        )
        .catch((lateEngineError: unknown) => {
          console.warn(
            "Failed to clean up a late OCR worker:",
            lateEngineError,
          );
        });
    }
    throw error;
  } finally {
    if (engineInitTimeout) clearTimeout(engineInitTimeout);
  }
}

/** Recognize one image file on a started engine, within `timeoutMs`. */
async function recognizeWithEngine(
  engine: OcrEngine,
  image: Buffer,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<{ text: string; confidence: number }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new ExtractionUnavailableError(timeoutMessage)),
      timeoutMs,
    );
  });

  try {
    // `failed` ends the wait at once if the worker thread dies mid-recognition.
    const result = await withAbort(
      Promise.race([
        engine.worker.recognize(image),
        engine.failed,
        timeoutPromise,
      ]),
      signal,
    );
    return { text: result.data.text, confidence: result.data.confidence };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * After a failed OCR job: recognition failures can leave Tesseract's cached worker in an unusable
 * state. Clear it and terminate the failed instance so the next job gets a clean worker.
 */
async function discardOcrEngine(engine: OcrEngine | null): Promise<void> {
  ocrEnginePromise = null;
  if (!engine) return;
  try {
    await withAbort(engine.terminate(), AbortSignal.timeout(2_000));
  } catch (terminationError: unknown) {
    console.warn(
      "Failed to terminate OCR worker after recognition error:",
      terminationError,
    );
  }
}

type PdfOcrPage = { text: string; confidence: number };

function isOcrRasterSize({
  width,
  height,
}: {
  width: number;
  height: number;
}): boolean {
  return (
    width >= MIN_PDF_OCR_RASTER_SIDE &&
    height >= MIN_PDF_OCR_RASTER_SIDE &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

/**
 * OCR the candidate pages of an open PDF, in page order: each page's largest raster, when it is
 * large enough to hold page text and within the image pixel limit. The whole PDF takes one slot of
 * the OCR queue and starts the engine at most once, and only when a page has a usable raster. It
 * stops after MAX_PDF_OCR_PAGES recognitions, when PDF_OCR_BUDGET_MS is spent (waiting for the
 * queue and starting the engine have their own bounds), or at the first OCR failure. Pages it does
 * not read keep their flag; only the caller's abort makes it throw.
 */
async function ocrPdfPages(
  pdf: PdfDocumentProxy,
  candidates: readonly number[],
  signal: AbortSignal | undefined,
): Promise<Map<number, PdfOcrPage>> {
  const read = new Map<number, PdfOcrPage>();
  const jobSignal = signal ?? new AbortController().signal;
  let deadline = Date.now() + PDF_OCR_BUDGET_MS;
  let recognitions = 0;
  let engine: OcrEngine | null = null;
  let release: (() => void) | null = null;
  let holdsPendingJob = false;
  try {
    for (const pageNumber of candidates) {
      if (recognitions >= MAX_PDF_OCR_PAGES || Date.now() >= deadline) break;
      jobSignal.throwIfAborted();

      let png: Buffer | null = null;
      try {
        // One page's raster at a time: it is released once encoded, before the next page.
        const raster = await largestPageRaster(
          pdf,
          pageNumber,
          isOcrRasterSize,
          jobSignal,
        );
        if (raster) {
          const encoded = encodePng(raster);
          png = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.length);
        }
      } catch (error: unknown) {
        jobSignal.throwIfAborted();
        console.warn(
          `Could not read PDF page ${pageNumber}'s image for OCR:`,
          error,
        );
      }
      if (!png) continue;

      if (!engine) {
        // Bounded like an image upload: one active job plus one waiter.
        if (pendingOcrJobs >= MAX_PENDING_OCR_JOBS) {
          console.warn("OCR is busy; scanned PDF pages stay flagged.");
          break;
        }
        pendingOcrJobs += 1;
        holdsPendingJob = true;
        const started = Date.now();
        try {
          release = await acquireOcrSlot(
            AbortSignal.any([
              jobSignal,
              AbortSignal.timeout(PDF_OCR_QUEUE_WAIT_MS),
            ]),
          );
        } catch (error: unknown) {
          jobSignal.throwIfAborted();
          console.warn("OCR is busy; scanned PDF pages stay flagged.", error);
          break;
        }
        try {
          engine = await startOcrJobEngine(jobSignal);
        } catch (error: unknown) {
          await discardOcrEngine(null);
          jobSignal.throwIfAborted();
          console.warn(
            "OCR is unavailable; scanned PDF pages stay flagged.",
            error,
          );
          break;
        }
        deadline += Date.now() - started;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      recognitions += 1;
      let result: { text: string; confidence: number };
      try {
        result = await recognizeWithEngine(
          engine,
          png,
          jobSignal,
          Math.min(remaining, OCR_RECOGNITION_TIMEOUT_MS),
          "PDF page OCR ran out of time.",
        );
      } catch (error: unknown) {
        await discardOcrEngine(engine);
        engine = null;
        jobSignal.throwIfAborted();
        // Pages read so far are kept; this page and the rest stay flagged.
        console.warn(`OCR of PDF page ${pageNumber} failed:`, error);
        break;
      }
      const text = result.text.trim();
      // An empty result (a blank or illegible page) leaves the page flagged.
      if (text) read.set(pageNumber, { text, confidence: result.confidence });
    }
  } finally {
    release?.();
    if (holdsPendingJob) pendingOcrJobs -= 1;
  }
  return read;
}

// Lazily construct and cache a single WordExtractor instance on first .doc/.docx use.
let wordExtractorPromise: Promise<WordExtractor> | null = null;

function getWordExtractor(): Promise<WordExtractor> {
  if (!wordExtractorPromise) {
    wordExtractorPromise = import("word-extractor")
      .then((mod) => new mod.default())
      .catch((error) => {
        wordExtractorPromise = null;
        throw error;
      });
  }
  return wordExtractorPromise;
}

export interface ExtractionResult {
  text: string;
  method:
    | "pdf_parse"
    | "pdf_scanned"
    | "pdf_ocr"
    | "tesseract_ocr"
    | "word_parse"
    | "plain_text";
  confidence?: number;
  /**
   * One-based numbers of PDF pages with little or no selectable text that OCR did not read. Any
   * text those pages do have is retained in `text`.
   */
  sparseTextPages?: number[];
  /** One-based numbers of PDF pages whose text was read by OCR (method `pdf_ocr`). */
  ocrPages?: number[];
  /** Mean OCR confidence (0–100) of `ocrPages`. */
  ocrConfidence?: number;
}

export type ExtractionMethod = ExtractionResult["method"];

/** A transient, server-side failure; its message is shown to the uploader. */
export class ExtractionUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtractionUnavailableError";
  }
}

/**
 * Extracted text that cannot be stored as-is. PostgreSQL text rejects U+0000, and the extracted
 * text is legal content, so it is refused rather than silently altered. The message is shown to
 * the uploader.
 */
export class ExtractedTextContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractedTextContentError";
  }
}

const NUL_CHARACTER_MESSAGE =
  "The file's text contains a null character (U+0000), which cannot be stored. Remove it, or save the document in another format, and upload it again.";

type VisiblePdfAnnotation = {
  subtype?: string;
  rect?: number[];
  hidden?: boolean;
  annotationFlags?: number;
  contentsObj?: { str?: string };
  fieldType?: string;
  fieldValue?: unknown;
  fieldName?: string;
  password?: boolean;
  options?: Array<{ exportValue: string; displayValue: string }>;
};

type PdfAnnotationText = { value: string; text: string };
type PdfTextItem = { str: string; transform: number[]; hasEOL: boolean };

/** A value elsewhere on the page is not evidence that this annotation was flattened. */
function annotationDuplicatesPageText(
  annotation: VisiblePdfAnnotation,
  value: string,
  items: PdfTextItem[],
): boolean {
  const rect = annotation.rect;
  if (!rect || rect.length !== 4) return false;
  const [left, bottom, right, top] = rect;
  if (
    left === undefined ||
    bottom === undefined ||
    right === undefined ||
    top === undefined
  )
    return false;
  const localItems = items.filter(({ transform }) => {
    const [, , , , x, y] = transform;
    if (x === undefined || y === undefined) return false;
    return x >= left && x <= right && y >= bottom && y <= top;
  });
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedValue = normalize(value);
  // PDF.js can split a value into several items, with explicit or implicit spaces.
  return ["", " "].some(
    (separator) =>
      normalize(
        localItems
          .map((item) => item.str + (item.hasEOL ? "\n" : ""))
          .join(separator),
      ) === normalizedValue,
  );
}

/** Only extract text that is displayed on the page, not comments or hidden notes. */
function visiblePdfAnnotationText(
  annotation: VisiblePdfAnnotation,
): PdfAnnotationText | null {
  // PDF.js may expose the raw /F bits without setting `hidden`. Hide
  // annotations marked Hidden (0x02) or NoView (0x20), even for display intent.
  if (
    annotation.hidden ||
    ((annotation.annotationFlags ?? 0) & (0x02 | 0x20)) !== 0
  )
    return null;

  if (annotation.subtype === "FreeText") {
    const text = annotation.contentsObj?.str?.trim();
    return text ? { value: text, text } : null;
  }

  if (
    annotation.subtype === "Widget" &&
    !annotation.password &&
    (annotation.fieldType === "Tx" || annotation.fieldType === "Ch")
  ) {
    const value = annotation.fieldValue;
    const selectedValues =
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
    const displayedValues =
      annotation.fieldType === "Ch"
        ? selectedValues.map(
            (selected) =>
              annotation.options?.find(
                (option) => option.exportValue === selected,
              )?.displayValue ?? selected,
          )
        : selectedValues;
    const text = displayedValues.join(", ").trim();
    if (!text) return null;
    return {
      value: text,
      text: annotation.fieldName ? `${annotation.fieldName}: ${text}` : text,
    };
  }

  return null;
}

/**
 * Extract text from a PDF buffer using unpdf.
 * Includes visible FreeText annotations and filled text/choice widgets in addition to page text.
 * Pages without usable text are OCR'd from their largest raster within bounds (ocrPdfPages); when
 * any is read the method is pdf_ocr, the OCR'd pages are listed in ocrPages, and only the pages
 * still unread in sparseTextPages. Otherwise, if the PDF appears to be scanned (low text density),
 * returns the extracted text with method pdf_scanned, or else lists the individual pages with
 * little or no selectable text in sparseTextPages; their text, if any, stays in the result.
 * Callers turn each of these into a warning.
 */
export async function extractTextFromPdf(
  buffer: Buffer,
  options?: { signal?: AbortSignal },
): Promise<ExtractionResult> {
  let pdf: Awaited<
    ReturnType<(typeof import("unpdf"))["getDocumentProxy"]>
  > | null = null;
  try {
    const { getDocumentProxy } = await import("unpdf");
    // PDF.js rejects Node Buffer instances and takes ownership of/detaches the supplied
    // ArrayBuffer. Make an owned copy so parsing cannot empty the original bytes before storage.
    // maxImageSize stops PDF.js from decoding a raster over the image pixel limit at all; the page
    // then has no image to OCR and stays flagged.
    pdf = await getDocumentProxy(new Uint8Array(buffer), {
      maxImageSize: MAX_IMAGE_PIXELS,
    });
    options?.signal?.throwIfAborted();
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new ExtractionLimitError(
        `PDF has too many pages. Maximum is ${MAX_PDF_PAGES.toLocaleString("en-US")} pages.`,
      );
    }

    const pages: string[] = [];
    // Per page: displayed annotation text, kept when OCR replaces the page's text layer, and the
    // non-whitespace characters of its actual text.
    const pageAnnotationTexts: string[] = [];
    const pageCharacters: number[] = [];
    const sparseTextPages: number[] = [];
    let characters = 0;
    let densityCharacters = 0;
    // Read one page at a time: unpdf's convenience helper materializes every page in parallel.
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      options?.signal?.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await withAbort(page.getTextContent(), options?.signal);
        const textItems = content.items.filter((item) => "str" in item);
        const parts: string[] = [];
        for (const item of textItems) {
          characters += item.str.length + 1;
          if (characters > MAX_EXTRACTED_TEXT_LENGTH)
            throw new ExtractionLimitError(
              "PDF text exceeds the 2,000,000-character processing limit.",
            );
          parts.push(item.str + (item.hasEOL ? "\n" : ""));
        }
        const baseText = parts.join("");
        // PDF.js keeps editable fields and FreeText stamps in annotations, outside
        // getTextContent(). Read the display layer too so chat can see filled PDFs.
        const annotations = await withAbort(
          page.getAnnotations({ intent: "display" }),
          options?.signal,
        );
        const annotationTexts = annotations.flatMap((annotation) => {
          const text = visiblePdfAnnotationText(annotation);
          return text &&
            !annotationDuplicatesPageText(annotation, text.value, textItems)
            ? [text]
            : [];
        });
        const annotationText = annotationTexts.length
          ? `\nVisible annotations: ${annotationTexts.map(({ text }) => text).join(" | ")}`
          : "";
        characters += annotationText.length;
        if (characters > MAX_EXTRACTED_TEXT_LENGTH)
          throw new ExtractionLimitError(
            "PDF text exceeds the 2,000,000-character processing limit.",
          );
        const pageText = baseText + annotationText;
        pages.push(pageText);
        pageAnnotationTexts.push(annotationText);
        // Count only actual page text and displayed values. Generated labels, field names,
        // and separators must not make a sparse scanned page appear fully extracted.
        const densityText =
          baseText + annotationTexts.map(({ value }) => value).join("");
        const pageDensityCharacters = densityText
          .replace(/\s+/g, " ")
          .trim().length;
        if (pageDensityCharacters > 0) {
          // Preserve a single page boundary between non-empty pages, as in extractedText.
          densityCharacters +=
            pageDensityCharacters + (densityCharacters > 0 ? 1 : 0);
        }
        const nonWhitespace = densityText.replace(/\s+/g, "").length;
        pageCharacters.push(nonWhitespace);
        if (nonWhitespace < MIN_PAGE_TEXT_CHARACTERS) {
          sparseTextPages.push(pageNumber);
        }
      } finally {
        page.cleanup();
      }
    }
    const extractedText = pages.join("\n").replace(/\s+/g, " ").trim();
    const totalPages = pdf.numPages;

    // Check if it's a scanned PDF (low text density)
    const pageCount = totalPages || 1;
    const avgCharsPerPage = densityCharacters / pageCount;

    // Density alone decides for anything longer than a couple of pages. A previous
    // `&& extractedText.length < 500` conjunct here was inert for short documents (under ~10 pages,
    // sparse density already implies a sub-500-character total) and actively harmful for long ones:
    // it suppressed scanned detection for exactly the large scans that need it, so a 200-page scan
    // carrying only per-page furniture (Bates stamps, scanner headers) was reported as a fully
    // parsed contract at confidence 100 and analyzed as if that furniture were the agreement.
    const isSparse = avgCharsPerPage < MIN_TEXT_DENSITY;
    const isShortDocument = pageCount <= SHORT_DOCUMENT_PAGE_COUNT;
    const isScanned = isSparse && (!isShortDocument || densityCharacters < 500);

    // OCR the pages without usable text: the sparse pages, or in a scanned document every page
    // short of the average density a text page has (scanner stamps alone stay below it).
    const unreadThreshold = isScanned
      ? MIN_TEXT_DENSITY
      : MIN_PAGE_TEXT_CHARACTERS;
    const ocrCandidates = pageCharacters.flatMap((count, index) =>
      count < unreadThreshold ? [index + 1] : [],
    );
    const ocr = await ocrPdfPages(pdf, ocrCandidates, options?.signal);
    if (ocr.size > 0) {
      // Each OCR'd page's text takes the place of its text layer, in page order.
      const merged = pages.map((pageText, index) => {
        const read = ocr.get(index + 1);
        return read ? read.text + pageAnnotationTexts[index] : pageText;
      });
      if (
        merged.reduce((total, pageText) => total + pageText.length + 1, 0) >
        MAX_EXTRACTED_TEXT_LENGTH
      ) {
        throw new ExtractionLimitError(
          "PDF text exceeds the 2,000,000-character processing limit.",
        );
      }
      const ocrPages = [...ocr.keys()];
      const unreadPages = ocrCandidates.filter((page) => !ocr.has(page));
      const confidences = [...ocr.values()].map(({ confidence }) => confidence);
      return {
        text: merged.join("\n").replace(/\s+/g, " ").trim(),
        method: "pdf_ocr",
        // As for pdf_parse, the share of pages read (here by text layer or OCR), below 100
        // because OCR can misread.
        confidence: Math.min(
          99,
          Math.floor(((pageCount - unreadPages.length) / pageCount) * 100),
        ),
        ...(unreadPages.length > 0 ? { sparseTextPages: unreadPages } : {}),
        ocrPages,
        ocrConfidence:
          Math.round(
            (confidences.reduce((sum, value) => sum + value, 0) /
              confidences.length) *
              10,
          ) / 10,
      };
    }

    if (isScanned) {
      // Scanned PDF whose pages OCR could not read: no usable raster, or OCR unavailable.
      // Empty text is rejected by the callers' "no text extracted" check. Sparse non-empty text is
      // kept and flagged pdf_scanned, and upload-pipeline turns that flag into a persisted warning.
      // Stamps or page headers can be the only text, so for them the warning is the only guard.
      return {
        text: extractedText,
        method: "pdf_scanned",
        confidence: 0,
      };
    }

    if (sparseTextPages.length > 0) {
      // A text PDF with some sparse pages: possibly image-only scans of schedules or signed
      // pages, which the document-wide average cannot see, so report them by page. Confidence is
      // the share of pages with substantial selectable text, kept below 100 because a sparse page
      // may be a scan whose content is missing from the text.
      const textPages = pageCount - sparseTextPages.length;
      return {
        text: extractedText,
        method: "pdf_parse",
        confidence: Math.min(99, Math.floor((textPages / pageCount) * 100)),
        sparseTextPages,
      };
    }

    return {
      text: extractedText,
      method: "pdf_parse",
      confidence: 100,
    };
  } catch (error: unknown) {
    if (error instanceof ExtractionLimitError) {
      throw error;
    }
    throw new Error(`Failed to parse PDF: ${getErrorMessage(error)}`);
  } finally {
    if (pdf) {
      try {
        await pdf.destroy();
      } catch (destroyError: unknown) {
        console.warn("Failed to release PDF parser resources:", destroyError);
      }
    }
  }
}

/**
 * Extract text from an image buffer using Tesseract.js OCR.
 */
export async function extractTextFromImage(
  buffer: Buffer,
  options?: { signal?: AbortSignal },
): Promise<ExtractionResult> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(150_000),
    ...(options?.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  // One shared worker must be serialized, but an unbounded promise chain would retain every
  // waiting upload buffer. Allow one active job plus one waiter and ask excess callers to retry.
  if (pendingOcrJobs >= MAX_PENDING_OCR_JOBS) {
    throw new ExtractionUnavailableError(
      "Image text extraction is busy. Please try again shortly.",
    );
  }

  pendingOcrJobs += 1;
  try {
    return await runSerializedOcr(async () => {
      let engine: OcrEngine | null = null;
      try {
        engine = await startOcrJobEngine(signal);
        const result = await recognizeWithEngine(
          engine,
          buffer,
          signal,
          OCR_RECOGNITION_TIMEOUT_MS,
          "Image text extraction timed out. Try a smaller image.",
        );

        return {
          text: result.text.trim(),
          method: "tesseract_ocr",
          confidence: result.confidence,
        };
      } catch (error: unknown) {
        await discardOcrEngine(engine);
        if (error instanceof ExtractionUnavailableError) {
          throw error;
        }
        throw new Error(`Failed to OCR image: ${getErrorMessage(error)}`);
      }
    }, signal);
  } catch (error) {
    if (signal.aborted)
      throw new ExtractionUnavailableError(
        "Image extraction exceeded the request deadline or was canceled. Please retry.",
      );
    throw error;
  } finally {
    pendingOcrJobs -= 1;
  }
}

/**
 * Extract text from a plain text file.
 */
export async function extractTextFromPlainText(
  buffer: Buffer,
): Promise<ExtractionResult> {
  let text: string;
  if (hasPrefix(buffer, [0xff, 0xfe])) {
    text = buffer.subarray(2).toString("utf16le");
  } else if (hasPrefix(buffer, [0xfe, 0xff])) {
    const source = buffer.subarray(2);
    // Native word swap instead of a per-byte JS loop (a 20 MB file was ~10M bounds-checked
    // iterations). swap16() throws on an odd byte count, so drop a trailing stray byte first —
    // matching the old loop, whose `index + 1 < length` bound also ignored it. Buffer.from copies,
    // so the caller's buffer is never mutated in place.
    text = Buffer.from(source.subarray(0, source.length & ~1))
      .swap16()
      .toString("utf16le");
  } else {
    text = buffer.toString("utf-8");
  }

  return {
    text: text.replace(/^\uFEFF/, "").trim(),
    method: "plain_text",
    confidence: 100,
  };
}

/**
 * Extract text from Word documents (.doc and .docx). word-extractor auto-detects the container,
 * so a single `word_parse` method label is used for both rather than a guessed doc/docx label.
 */
export async function extractTextFromWord(
  buffer: Buffer,
): Promise<ExtractionResult> {
  try {
    if (isOleCompoundFile(buffer)) validateOleCompoundFile(buffer);
    const wordExtractor = await getWordExtractor();
    const extracted = await wordExtractor.extract(buffer);
    const sections = [extracted.getBody().trim()].filter(Boolean);
    let characters = sections[0]?.length ?? 0;
    // Word stores these parts outside the body. Keep their provenance explicit rather than
    // implying that a note or floating textbox occupied a particular position in the body.
    // Headers/footers are included once per parsed part, not repeated for every rendered page:
    // they can contain material terms as well as page furniture. Editorial comments are omitted.
    const supplementaryParts = [
      ["Footnotes", extracted.getFootnotes()],
      ["Endnotes", extracted.getEndnotes()],
      [
        "Body textboxes",
        extracted.getTextboxes({ includeHeadersAndFooters: false }),
      ],
      ["Headers and footers", extracted.getHeaders()],
      [
        "Header and footer textboxes",
        extracted.getTextboxes({ includeBody: false }),
      ],
    ] as const;
    for (const [label, value] of supplementaryParts) {
      const content = value.trim();
      if (!content) continue;
      const section = `[${label}]\n${content}`;
      characters += section.length + (sections.length ? 2 : 0);
      sections.push(section);
    }
    if (characters > MAX_EXTRACTED_TEXT_LENGTH) {
      throw new ExtractionLimitError(
        "Word text exceeds the 2,000,000-character processing limit.",
      );
    }
    const text = sections.join("\n\n");

    return {
      text,
      method: "word_parse",
      confidence: 100,
    };
  } catch (error: unknown) {
    if (error instanceof ExtractionLimitError) throw error;
    throw new Error(`Failed to parse Word document: ${getErrorMessage(error)}`);
  }
}

/**
 * Process a file buffer and extract text based on its MIME type.
 * @param buffer The file content as a Buffer
 * @param mimeType The MIME type of the file
 * @returns ExtractionResult with extracted text and metadata
 */
export async function processFile(
  buffer: Buffer,
  mimeType: string,
  fileName?: string,
  options?: { signal?: AbortSignal },
): Promise<ExtractionResult> {
  const supportedMimeType = validateMimeType(mimeType, fileName);
  validateFileSignature(buffer, supportedMimeType);
  return processValidatedFile(buffer, supportedMimeType, options);
}

/**
 * Internal extraction path for callers that have already validated MIME and signature.
 * Every extractor's output passes through here before it can be persisted or hashed.
 *
 * @throws ExtractedTextContentError when the extracted text contains U+0000.
 */
export async function processValidatedFile(
  buffer: Buffer,
  supportedMimeType: string,
  options?: { signal?: AbortSignal },
): Promise<ExtractionResult> {
  const result = await extractValidatedFile(buffer, supportedMimeType, options);
  // The plain-text signature check samples only the first 8 KiB, a UTF-16 BOM legitimately
  // brings NUL bytes into that sample, and parsers or OCR can emit U+0000 themselves.
  if (result.text.includes("\u0000")) {
    throw new ExtractedTextContentError(NUL_CHARACTER_MESSAGE);
  }
  return result;
}

async function extractValidatedFile(
  buffer: Buffer,
  supportedMimeType: string,
  options?: { signal?: AbortSignal },
): Promise<ExtractionResult> {
  options?.signal?.throwIfAborted();
  if (supportedMimeType === DOCX_MIME_TYPE) await validateDocxExpansion(buffer);
  if (supportedMimeType === PDF_MIME_TYPE) {
    await validatePdfExpansion(buffer, options?.signal);
  }
  if (supportedMimeType.startsWith("image/")) validateImageDimensions(buffer);

  if (supportedMimeType === PDF_MIME_TYPE) {
    return extractTextFromPdf(buffer, options);
  }

  if (supportedMimeType.startsWith("image/")) {
    return extractTextFromImage(buffer, options);
  }

  if (supportedMimeType === TEXT_MIME_TYPE) {
    return extractTextFromPlainText(buffer);
  }

  if (
    supportedMimeType === DOC_MIME_TYPE ||
    supportedMimeType === DOCX_MIME_TYPE
  ) {
    return extractTextFromWord(buffer);
  }

  // This shouldn't happen due to validateMimeType, but just in case
  throw new Error(`Unsupported file type: ${supportedMimeType}`);
}
