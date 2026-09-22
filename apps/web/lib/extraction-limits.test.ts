import { expect, it } from "vitest";
import {
  validateDocxExpansion,
  validateImageDimensions,
} from "./extraction-limits";

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
