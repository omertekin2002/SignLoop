import {
  constants as zlibConstants,
  deflateRawSync,
  deflateSync,
  inflateSync,
} from "node:zlib";
import { expect, it } from "vitest";
import {
  ExtractionLimitError,
  validateDocxExpansion,
  validateImageDimensions,
  validatePdfExpansion,
} from "./extraction-limits";

const MiB = 1024 * 1024;

function pdfWithStreams(streams: { data: Buffer; length?: string }[]) {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    ...streams.flatMap(({ data, length }, index) => [
      Buffer.from(
        `${index + 1} 0 obj\n<< /Length ${length ?? data.length} /Filter /FlateDecode >>\nstream\r\n`,
      ),
      data,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
    Buffer.from("%%EOF\n"),
  ]);
}

function spaces(bytes: number) {
  return deflateSync(Buffer.alloc(bytes, 0x20));
}

function png(width: number, height: number) {
  const buffer = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

it("checks dimensions from image headers before decoding pixels", () => {
  expect(() => validateImageDimensions(png(100, 100))).not.toThrow();
  expect(() => validateImageDimensions(png(10000, 10000))).toThrow(
    /25 megapixels/,
  );
});

it("rejects declared DOCX expansion before opening compressed entries", async () => {
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30 + name.length + 1);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(1, 20);
  central.writeUInt32LE(17 * 1024 * 1024, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  await expect(
    validateDocxExpansion(Buffer.concat([local, central, end])),
  ).rejects.toThrow(/16 MB/);
});

it("accepts ordinary PDF Flate streams and skips ones zlib cannot inflate", async () => {
  const corrupt = Buffer.concat([
    Buffer.from([0x78, 0x9c]),
    Buffer.alloc(64, 0xff),
  ]);
  await expect(
    validatePdfExpansion(
      pdfWithStreams([
        { data: deflateSync(Buffer.from("BT /F1 12 Tf (Clause 1) Tj ET")) },
        { data: corrupt },
        { data: spaces(8 * MiB) },
      ]),
    ),
  ).resolves.toBeUndefined();
});

it("rejects a PDF Flate stream that inflates past the budget before pdf.js sees it", async () => {
  // A ~66 KB stream that inflates to 65 MiB, with an indirect /Length so the scanner cannot rely
  // on the dictionary, and a corrupt tail so zlib fails only after producing the output.
  const bomb = Buffer.concat([
    deflateSync(Buffer.alloc(65 * MiB, 0x20), {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    }),
    Buffer.from([0xff, 0xff]),
  ]);
  expect(bomb.length).toBeLessThan(MiB);
  await expect(
    validatePdfExpansion(pdfWithStreams([{ data: bomb, length: "9 0 R" }])),
  ).rejects.toBeInstanceOf(ExtractionLimitError);
});

it("counts a Flate stream that refers back before its start, which pdf.js reads as zeros", async () => {
  const zeros = deflateRawSync(Buffer.alloc(65 * MiB), {
    dictionary: Buffer.alloc(32 * 1024),
  });
  const bomb = Buffer.concat([Buffer.from([0x78, 0x9c]), zeros]);
  expect(() => inflateSync(bomb)).toThrow(/too far back/);
  await expect(
    validatePdfExpansion(pdfWithStreams([{ data: bomb }])),
  ).rejects.toBeInstanceOf(ExtractionLimitError);
});

it("applies the PDF Flate budget across all streams", async () => {
  const half = spaces(33 * MiB);
  await expect(
    validatePdfExpansion(pdfWithStreams([{ data: half }])),
  ).resolves.toBeUndefined();
  await expect(
    validatePdfExpansion(pdfWithStreams([{ data: half }, { data: half }])),
  ).rejects.toThrow(/64 MB/);
});
