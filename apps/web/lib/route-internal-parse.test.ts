import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readObject, processValidatedFile } = vi.hoisted(() => ({
  readObject: vi.fn(),
  processValidatedFile: vi.fn(),
}));

vi.mock("@/lib/object-storage", () => ({ readObject }));
vi.mock("@/lib/text-extraction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/text-extraction")>()),
  processValidatedFile,
}));

import { maxDuration, POST } from "@/app/api/internal/parse/route";
import { signParseRequest } from "./parse-protocol";
import {
  ExtractedTextContentError,
  ExtractionLimitError,
  ExtractionUnavailableError,
} from "./text-extraction";

const STORAGE_KEY = "uploads/0b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d";
const SECRET_TEXT = "Confidential: the buyer pays 4.2 million.";

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const parseRequest = (body: unknown) =>
  new Request("http://localhost/api/internal/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const signed = (overrides: Record<string, unknown> = {}) => ({
  ...signParseRequest({ storageKey: STORAGE_KEY, mimeType: "application/pdf" }),
  ...overrides,
});

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "a-test-cookie-password-of-32-chars!!");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  readObject.mockResolvedValue(streamOf(Buffer.from("%PDF-1.4 lease")));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("POST /api/internal/parse", () => {
  it("has its own duration, below the 180 s of the upload routes that wait for it", () => {
    expect(maxDuration).toBeGreaterThanOrEqual(150);
    expect(maxDuration).toBeLessThan(180);
  });

  // Bodies are built per test, after the key is configured.
  it.each([
    ["no body", () => undefined],
    ["malformed JSON", () => "{"],
    ["a missing signature", () => { const { signature: _, ...rest } = signed(); return rest; }],
    ["a tampered storage key", () => signed({ storageKey: "uploads/1b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d" })],
    ["a tampered MIME type", () => signed({ mimeType: "image/png" })],
    ["a forged signature", () => signed({ signature: "A".repeat(43) })],
    ["an oversized body", () => ({ ...signed(), padding: "x".repeat(20_000) })],
  ])("answers 404 for %s without reading storage", async (_label, makeBody) => {
    const body = makeBody();
    const response = await POST(
      body === undefined
        ? new Request("http://localhost/api/internal/parse", { method: "POST" })
        : parseRequest(body),
    );

    expect(response.status).toBe(404);
    expect(readObject).not.toHaveBeenCalled();
    expect(processValidatedFile).not.toHaveBeenCalled();
  });

  it("answers 404 for an expired signature", async () => {
    const body = signed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(body.expiresAt + 1);

    const response = await POST(parseRequest(body));

    expect(response.status).toBe(404);
    expect(readObject).not.toHaveBeenCalled();
  });

  it("answers 404 when the deployment has no key to verify with", async () => {
    const body = signed();
    vi.stubEnv("WORKOS_COOKIE_PASSWORD", "");

    expect((await POST(parseRequest(body))).status).toBe(404);
    expect(readObject).not.toHaveBeenCalled();
  });

  it("reads the signed object and returns the parsers' result", async () => {
    processValidatedFile.mockResolvedValue({
      text: "This lease renews automatically.",
      method: "pdf_parse",
      sparseTextPages: [2, 3],
    });

    const response = await POST(parseRequest(signed()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      text: "This lease renews automatically.",
      method: "pdf_parse",
      confidence: null,
      sparseTextPages: [2, 3],
    });
    expect(readObject).toHaveBeenCalledExactlyOnceWith(STORAGE_KEY, expect.any(AbortSignal));
    expect(processValidatedFile).toHaveBeenCalledExactlyOnceWith(
      Buffer.from("%PDF-1.4 lease"),
      "application/pdf",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("streams a result larger than Vercel's buffered response limit", async () => {
    const text = "ş".repeat(1_999_999);
    processValidatedFile.mockResolvedValue({ text, method: "plain_text" });

    const response = await POST(parseRequest(signed()));
    const body = await response.text();

    expect(Buffer.byteLength(body)).toBeGreaterThan(3_900_000);
    expect(JSON.parse(body)).toMatchObject({ ok: true, text });
  });

  it.each([
    [
      "limit",
      new ExtractionLimitError("PDF has too many pages. Maximum is 500."),
      "PDF has too many pages. Maximum is 500.",
    ],
    [
      "content",
      new ExtractedTextContentError("The file's text contains a null character (U+0000)."),
      "The file's text contains a null character (U+0000).",
    ],
    [
      "unavailable",
      new ExtractionUnavailableError("Image text extraction is unavailable right now."),
      "Image text extraction is unavailable right now.",
    ],
  ])("reports a %s error with the server's message", async (kind, error, message) => {
    processValidatedFile.mockRejectedValue(error);

    const response = await POST(parseRequest(signed()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, kind, message });
  });

  it("reports a parser failure generically, logging the cause instead of returning it", async () => {
    const cause = new Error(`Unexpected token near "${SECRET_TEXT}"`);
    processValidatedFile.mockRejectedValue(cause);

    const response = await POST(parseRequest(signed()));
    const body = await response.text();

    expect(JSON.parse(body)).toEqual({
      ok: false,
      kind: "failed",
      message: "Text extraction failed",
    });
    expect(body).not.toContain("Confidential");
    expect(consoleError).toHaveBeenCalledWith("Text extraction failed:", cause);
  });

  it("refuses extracted text over the stored-text bound", async () => {
    processValidatedFile.mockResolvedValue({ text: "a".repeat(2_000_001), method: "plain_text" });

    expect(await (await POST(parseRequest(signed()))).json()).toEqual({
      ok: false,
      kind: "limit",
      message: "Extracted text is too large. Maximum length is 2,000,000 characters.",
    });
  });

  it("stops reading an object past 10 MiB and never parses it", async () => {
    const mebibyte = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 11 }, () => mebibyte);
    readObject.mockResolvedValue(streamOf(...chunks));

    expect(await (await POST(parseRequest(signed()))).json()).toEqual({
      ok: false,
      kind: "limit",
      message: "File too large. Maximum size is 10 MB.",
    });
    expect(processValidatedFile).not.toHaveBeenCalled();
  });

  it.each([
    ["is missing", () => readObject.mockResolvedValue(null)],
    ["cannot be read", () => readObject.mockRejectedValue(new Error("network down"))],
  ])("reports a stored object that %s as unavailable", async (_label, arrange) => {
    arrange();

    expect(await (await POST(parseRequest(signed()))).json()).toEqual({
      ok: false,
      kind: "unavailable",
      message: "The uploaded file could not be read. Please try again.",
    });
    expect(processValidatedFile).not.toHaveBeenCalled();
  });

  it("reports a canceled parse as timed out", async () => {
    const controller = new AbortController();
    processValidatedFile.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const request = new Request(parseRequest(signed()), { signal: controller.signal });

    expect(await (await POST(request)).json()).toEqual({
      ok: false,
      kind: "unavailable",
      message: "Upload processing timed out or was canceled.",
    });
  });
});
