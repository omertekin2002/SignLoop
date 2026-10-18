// Untyped CommonJS modules that report where the unbundled OCR files live at runtime
// (see resolveOcrAssets in lib/text-extraction.ts). Only the fields read there are declared.

declare module "tesseract.js/src/worker/node/defaultOptions.js" {
  const options: { workerPath: string };
  export default options;
}

declare module "@tesseract.js-data/eng" {
  /** `langPath` is the package's `4.0.0` directory, which holds `eng.traineddata.gz`. */
  const language: { code: string; gzip: boolean; langPath: string };
  export default language;
}
