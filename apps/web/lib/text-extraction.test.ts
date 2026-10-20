import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ExtractedTextContentError,
  extractTextFromPlainText,
  extractTextFromWord,
  processFile,
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

  it("decodes big-endian UTF-16 and leaves the source buffer untouched", async () => {
    const body = Buffer.from("Contract text", "utf16le").swap16(); // → UTF-16BE bytes
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    const pristine = Buffer.from(utf16be);

    await expect(extractTextFromPlainText(utf16be)).resolves.toMatchObject({
      text: "Contract text",
    });
    // The decoder must copy, not swap the caller's bytes in place — the same buffer is handed to
    // object storage after extraction.
    expect(utf16be.equals(pristine)).toBe(true);
  });

  it("tolerates a big-endian UTF-16 body with a stray trailing byte", async () => {
    const body = Buffer.from("Contract text", "utf16le").swap16();
    const utf16be = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      body,
      Buffer.from([0x00]),
    ]);

    await expect(extractTextFromPlainText(utf16be)).resolves.toMatchObject({
      text: "Contract text",
    });
  });
});

describe("processFile with NUL characters in text", () => {
  const utf16le = (text: string) =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const utf16be = (text: string) =>
    Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(text, "utf16le").swap16(),
    ]);

  it("rejects a NUL that follows more than 8 KiB of clean UTF-8 text", async () => {
    const buffer = Buffer.from(
      `${"A".repeat(9_000)}\u0000Notice period: 30 days.`,
      "utf8",
    );
    // The binary sniff samples only the first 8 KiB, so this file gets past it.
    expect(() => validateFileSignature(buffer, "text/plain")).not.toThrow();

    await expect(
      processFile(buffer, "text/plain", "contract.txt"),
    ).rejects.toThrow(ExtractedTextContentError);
    await expect(
      processFile(buffer, "text/plain", "contract.txt"),
    ).rejects.toThrow(/null character \(U\+0000\)/);
  });

  it.each([
    ["little-endian", utf16le],
    ["big-endian", utf16be],
  ])("rejects a NUL code unit in %s UTF-16 text", async (_, encode) => {
    const buffer = encode("Notice period:\u000030 days.");
    expect(() => validateFileSignature(buffer, "text/plain")).not.toThrow();

    await expect(
      processFile(buffer, "text/plain", "contract.txt"),
    ).rejects.toThrow(ExtractedTextContentError);
  });

  it.each([
    ["little-endian UTF-16", utf16le],
    ["big-endian UTF-16", utf16be],
    ["UTF-8", (text: string) => Buffer.from(text, "utf8")],
  ])(
    "keeps tabs, line breaks, other controls and Unicode in clean %s text",
    async (_, encode) => {
      const text =
        "Kündigungsfrist:\t30 Tage\r\nİptal şartı — 30 gün\n\fSchedule \u0001A ✍️ 契約";

      await expect(
        processFile(encode(text), "text/plain", "contract.txt"),
      ).resolves.toEqual({ text, method: "plain_text", confidence: 100 });
    },
  );
});

describe("extractTextFromWord with legacy .doc files", () => {
  // A two-paragraph Word 97 file written by macOS textutil, gzipped. It has no author metadata.
  const WORD_97_FIXTURE_GZIP_BASE64 =
    "H4sIAAAAAAACE+2cTUwTQRTH/92WQivQBQQr+FHRoImGIGriwRgIiIgG0JJ4FVq+khYIFIEbFxOPGA9eTAwknEyMRuJV9OBN5cJBTngk0YjcOMj63uwUCgUpxAjI+23ezux8983M7sxmX6c+58yOvir8ijVchRNLlgfuhDAHyYn4hQmc1GFLlmVxUIDEEvYU38bf6Q6dz31r93IOdaqDOz5Mko0wgQ0o4AQIDtpSjj9jWb5N/XEi6jymr8awOZzmIFLnDUkmyXvtxvnBIxo7x3eaUgFj5XqGJB/CbufTmnEkCLufKnSjCzH0ohkhcgNooZAwhsgXQysG6VyKLDqCdBVSqcMU10PpOU+7Ovegg8IG0EmpO3TOXkTRp/IKuxj9nF8UTewTMhvqnLhNUlXnX1nnzYli/hNoTZ71oQSZZcY914h7MmPeG8hq9A3nvMybzTf9FYWrEi/3v7AvcYgK9je58MFLw6CTXANOdVwEKn5aBrt0e6inNR+v5ZrVntxQu2x+dPBjpFE/SqK1Hldy2VdQWbFgjZLLd6VqWhO2USn9VA6vMxvXWUHW6NXoWsr1ewJ+z6TO+q7lSljBpCX4+YZmmKsy22+yOMN190hKw76JlBKlRvdRw+rJHSD3DjWQVdFF8ZeoHCOFcoK0mI6qZTUr8EKKtVeSWjq10lNtcS21MoL7dI5R3hDlDuAW+dpJuTH1gs6FsoyHfsxPUcM7VJkzNyMlLMl3A4e6dsFpOpJC4yEBJ+ZNmUXbZNw9mT6BCQwjt+zvl85js3hlWlI/ZYjKBUEQBEEQBGE/s0Q7apc3eXfJIbMPni0sNnSYzx9l4Ozp1194j+LXcSym3mTM/RI9CoIgCIIgCIIgCMJe3f8b0x+nn5YWmY+f0P7/3OIL2f8LgiAIgiAIgiAIwt7EoffwTtgfx/NX9PylfDrs/3XwkOslOQDbupmtObNJfDo+B2xDAOTBtr5nS/UCkkM6/jC5bHJURHKE5CjJMZLjOp6lOMG/JH/J8E9hg4ZuZY9xTdsBD21p/BQgzREvi8eQ22ObREza0TXr5TlFMqz959GEZrQggtZtjd9sGr2JvyeVPOozeG21cFdZt4RRTW4I/crgYz0LlI0ohOHgObSV+pFQfxqCqtaosoYZwg2qvW3Z4obNOLqVsclGnKH6DT13U63fXFX/2l++tfZcpvq3qn9/Qv2CIAjCzvAbp9MKUgBMAAA=";

  it("still extracts a real Word 97 document after the structure check", async () => {
    const source = gunzipSync(
      Buffer.from(WORD_97_FIXTURE_GZIP_BASE64, "base64"),
    );

    await expect(extractTextFromWord(source)).resolves.toEqual({
      text: "Contract body text.\n\nSecond paragraph with terms.",
      method: "word_parse",
      confidence: 100,
    });
  });

  it("rejects a two-sector FAT cycle instead of looping in the Word parser", async () => {
    // Sector 0 is the FAT and lists 0 -> 1 -> 0. word-extractor follows that chain for the
    // short-sector table before anything else and, unguarded, never returns.
    const source = Buffer.alloc(512 * 3, 0xff);
    Buffer.from("d0cf11e0a1b11ae1", "hex").copy(source);
    source.writeUInt16LE(9, 30);
    source.writeUInt16LE(6, 32);
    source.writeInt32LE(1, 44);
    source.writeInt32LE(0, 48);
    source.writeInt32LE(4096, 56);
    source.writeInt32LE(0, 60);
    source.writeInt32LE(2, 64);
    source.writeInt32LE(-2, 68);
    source.writeInt32LE(0, 72);
    source.writeInt32LE(0, 76);
    source.writeInt32LE(1, 512);
    source.writeInt32LE(0, 516);

    await expect(extractTextFromWord(source)).rejects.toThrow(
      /Failed to parse Word document: .*loops back on itself/,
    );
  });
});
