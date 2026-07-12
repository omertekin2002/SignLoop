import { describe, expect, it } from "vitest";
import {
  extractTextFromPlainText,
  validateFileSignature,
  validateMimeType,
} from "./text-extraction";

describe("validateMimeType", () => {
  it("accepts canonical Word MIME types", () => {
    expect(validateMimeType("application/msword")).toBe("application/msword");
    expect(
      validateMimeType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("infers DOCX from filename when browser sends octet-stream", () => {
    expect(validateMimeType("application/octet-stream", "msa.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("infers DOC from filename when MIME type is empty", () => {
    expect(validateMimeType("", "legacy-contract.doc")).toBe(
      "application/msword",
    );
  });

  it("rejects unsupported file types", () => {
    expect(() => validateMimeType("application/zip", "archive.zip")).toThrow(
      /not supported/i,
    );
  });

  it("rejects a specific MIME type that conflicts with the filename", () => {
    expect(() => validateMimeType("application/pdf", "renamed.docx")).toThrow(
      /does not match/i,
    );
  });

  it("normalizes common browser aliases and Word-family extension hints", () => {
    expect(validateMimeType("application/x-pdf", "contract.pdf")).toBe(
      "application/pdf",
    );
    expect(validateMimeType("image/x-png", "scan.png")).toBe("image/png");
    expect(validateMimeType("application/msword", "contract.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});

describe("validateFileSignature", () => {
  it("accepts matching PDF and DOCX signatures", () => {
    expect(() =>
      validateFileSignature(Buffer.from("%PDF-1.7\nbody"), "application/pdf"),
    ).not.toThrow();

    const docx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("[Content_Types].xml word/document.xml"),
    ]);
    expect(() =>
      validateFileSignature(
        docx,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).not.toThrow();
  });

  it("rejects renamed binary content and empty files", () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("archive contents"),
    ]);

    expect(() => validateFileSignature(zip, "application/pdf")).toThrow(
      /contents do not match/i,
    );
    expect(() => validateFileSignature(zip, "text/plain")).toThrow(
      /contents do not match/i,
    );
    expect(() =>
      validateFileSignature(Buffer.alloc(0), "application/pdf"),
    ).toThrow(/empty/i);
  });

  it("accepts legal text that mentions binary signatures", () => {
    expect(() =>
      validateFileSignature(
        Buffer.from("The exhibit references %PDF-1.7 and a GIF logo."),
        "text/plain",
      ),
    ).not.toThrow();
    expect(() =>
      validateFileSignature(
        Buffer.from("GIF is an image format."),
        "text/plain",
      ),
    ).not.toThrow();
  });

  it("accepts and decodes UTF-16 text with a BOM", async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Contract text", "utf16le"),
    ]);
    expect(() => validateFileSignature(utf16, "text/plain")).not.toThrow();
    await expect(extractTextFromPlainText(utf16)).resolves.toMatchObject({
      text: "Contract text",
    });
  });
});
