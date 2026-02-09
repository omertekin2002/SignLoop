import { describe, expect, it } from "vitest";
import { validateMimeType } from "./text-extraction";

describe("validateMimeType", () => {
  it("accepts canonical Word MIME types", () => {
    expect(validateMimeType("application/msword")).toBe("application/msword");
    expect(validateMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("infers DOCX from filename when browser sends octet-stream", () => {
    expect(validateMimeType("application/octet-stream", "msa.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("infers DOC from filename when MIME type is empty", () => {
    expect(validateMimeType("", "legacy-contract.doc")).toBe("application/msword");
  });

  it("rejects unsupported file types", () => {
    expect(() => validateMimeType("application/zip", "archive.zip")).toThrow(/not supported/i);
  });
});
