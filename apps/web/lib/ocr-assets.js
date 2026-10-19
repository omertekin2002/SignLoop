// Facts about the OCR files the server needs at runtime, shared by next.config.js (build tracing),
// lib/text-extraction.ts (startup checks) and scripts/check-ocr-trace.mjs (build verification).
// Plain JavaScript so the Next.js config and the check script can import it without a compiler.

/** Routes whose uploads can run image OCR. */
export const OCR_ROUTES = Object.freeze([
  "/api/contracts/[id]/upload",
  "/api/projects/[id]/context",
]);

/**
 * The tesseract.js-core builds the Node worker can require when started with `legacyCore: true`,
 * chosen by the runtime's WebAssembly SIMD support. They contain both engines; recognition still
 * uses LSTM. (tesseract.js 7 loads these on Node regardless, and the option keeps that choice
 * deterministic.) Each `<build>.js` reads `<build>.wasm` from its own directory; the
 * `<build>.wasm.js` files are browser bundles and are never loaded on the server.
 */
export const TESSERACT_CORE_BUILDS = Object.freeze([
  "tesseract-core",
  "tesseract-core-simd",
  "tesseract-core-relaxedsimd",
]);

/**
 * The English LSTM model inside @tesseract.js-data/eng: the integer model tesseract.js would
 * otherwise download from its CDN. The package's `4.0.0` directory adds the unused legacy engine.
 */
export const ENGLISH_MODEL_DIRECTORY = "4.0.0_best_int";
export const ENGLISH_MODEL_FILE = "eng.traineddata.gz";
