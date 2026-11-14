import { imageSize } from "image-size";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, type RawRaster } from "./png-encode";

/** The PNG's chunks, checking each CRC with zlib's implementation. */
function readChunks(png: Uint8Array) {
  const buffer = Buffer.from(png);
  expect([...buffer.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const chunks: Array<{ type: string; body: Buffer }> = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    expect(buffer.readUInt32BE(offset + 8 + length)).toBe(
      crc32(buffer.subarray(offset + 4, offset + 8 + length)),
    );
    chunks.push({ type, body });
    offset += 12 + length;
  }
  return chunks;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function raster(channels: 1 | 3 | 4, width = 7, height = 5): RawRaster {
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
  return { data, width, height, channels };
}

describe("encodePng", () => {
  it.each([
    [1, 0],
    [3, 2],
    [4, 6],
  ] as const)(
    "round-trips a %i-channel raster as PNG colour type %i",
    (channels, colorType) => {
      const source = raster(channels);
      const original = Uint8Array.from(source.data);

      const png = encodePng(source);

      expect(imageSize(png)).toMatchObject({
        type: "png",
        width: 7,
        height: 5,
      });
      const chunks = readChunks(png);
      expect(chunks.map(({ type }) => type)).toEqual(["IHDR", "IDAT", "IEND"]);
      const header = chunks[0]!.body;
      expect(header.readUInt32BE(0)).toBe(7);
      expect(header.readUInt32BE(4)).toBe(5);
      expect([...header.subarray(8)]).toEqual([8, colorType, 0, 0, 0]);
      // Each scanline is its filter byte (0, None) followed by the row's pixels unchanged.
      const scanlines = inflateSync(chunks[1]!.body);
      const stride = 7 * channels;
      expect(scanlines.length).toBe((stride + 1) * 5);
      for (let row = 0; row < 5; row++) {
        expect(scanlines[row * (stride + 1)]).toBe(0);
        expect([
          ...scanlines.subarray(
            row * (stride + 1) + 1,
            (row + 1) * (stride + 1),
          ),
        ]).toEqual([...original.subarray(row * stride, (row + 1) * stride)]);
      }
      // The input raster is not modified.
      expect(source.data).toEqual(original);
    },
  );

  it("accepts PDF.js's Uint8ClampedArray pixels", () => {
    const png = encodePng({
      data: new Uint8ClampedArray(2 * 2 * 3).fill(200),
      width: 2,
      height: 2,
      channels: 3,
    });
    expect(imageSize(png)).toMatchObject({ width: 2, height: 2 });
  });

  it("rejects a raster whose data does not match its dimensions", () => {
    expect(() =>
      encodePng({ data: new Uint8Array(10), width: 2, height: 2, channels: 3 }),
    ).toThrow(/does not match/);
    expect(() =>
      encodePng({ data: new Uint8Array(0), width: 0, height: 0, channels: 1 }),
    ).toThrow(/Invalid raster/);
  });
});
