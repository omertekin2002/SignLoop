import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { processValidatedFile } from "./text-extraction";

// Runs the installed tesseract.js worker thread, WebAssembly core and bundled English model with
// no mocks or network. The fixture is a synthetic PNG described in fixtures/README.md.
describe("real image OCR", () => {
  it("reads a PNG with the bundled English model and writes nothing to the working directory", async () => {
    const image = await readFile(
      new URL("./fixtures/ocr-notice-terms.png", import.meta.url),
    );
    const original = Buffer.from(image);

    const result = await processValidatedFile(image, "image/png");

    expect(result.method).toBe("tesseract_ocr");
    expect(result.text.replace(/\s+/g, " ")).toBe(
      "Termination fee: 250 USD Notice period: 30 days",
    );
    expect(result.confidence).toBeGreaterThan(80);
    // tesseract.js's default language cache writes here; Vercel's filesystem is read-only.
    expect(existsSync(path.join(process.cwd(), "eng.traineddata"))).toBe(false);
    expect(image.equals(original)).toBe(true);
  }, 30_000);
});
