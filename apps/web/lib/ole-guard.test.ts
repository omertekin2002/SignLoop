import { describe, expect, it } from "vitest";
import { validateOleCompoundFile } from "./ole-guard";

const SECTOR = 512;
const END_OF_CHAIN = -2;
const FREE = -1;

interface Entry {
  name: string;
  type: number;
  left?: number;
  right?: number;
  child?: number;
  start: number;
  size: number;
}

/**
 * A minimal version 3 compound file: sector 0 holds the FAT, sector 1 the directory, and sectors
 * 2-9 a 4,096-byte WordDocument stream.
 */
function oleFile(
  options: {
    sectors?: number;
    header?: Record<number, number>;
    fat?: Record<number, number>;
    entries?: Entry[];
    extraSectors?: Record<number, number[]>;
  } = {},
) {
  const sectors = options.sectors ?? 10;
  const file = Buffer.alloc(SECTOR * (sectors + 1));
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(file);
  file.writeUInt16LE(0x3e, 24);
  file.writeUInt16LE(3, 26);
  file.writeUInt16LE(0xfffe, 28);
  file.writeUInt16LE(9, 30);
  file.writeUInt16LE(6, 32);
  const header: Record<number, number> = {
    44: 1,
    48: 1,
    56: 4096,
    60: END_OF_CHAIN,
    64: 0,
    68: END_OF_CHAIN,
    72: 0,
    ...options.header,
  };
  for (const [offset, value] of Object.entries(header)) {
    file.writeInt32LE(value, Number(offset));
  }
  for (let index = 0; index < 109; index++) {
    file.writeInt32LE(index === 0 ? 0 : FREE, 76 + index * 4);
  }

  const fat: Record<number, number> = {
    0: -3,
    1: END_OF_CHAIN,
    2: 3,
    3: 4,
    4: 5,
    5: 6,
    6: 7,
    7: 8,
    8: 9,
    9: END_OF_CHAIN,
    ...options.fat,
  };
  for (let index = 0; index < SECTOR / 4; index++) {
    file.writeInt32LE(fat[index] ?? FREE, SECTOR + index * 4);
  }

  const entries = options.entries ?? [
    { name: "Root Entry", type: 5, child: 1, start: END_OF_CHAIN, size: 0 },
    { name: "WordDocument", type: 2, start: 2, size: 4096 },
  ];
  for (let index = 0; index < SECTOR / 128; index++) {
    const offset = 2 * SECTOR + index * 128;
    const entry = entries[index];
    file.writeInt32LE(entry?.left ?? FREE, offset + 68);
    file.writeInt32LE(entry?.right ?? FREE, offset + 72);
    file.writeInt32LE(entry?.child ?? FREE, offset + 76);
    if (!entry) continue;
    const name = Buffer.from(`${entry.name}\0`, "utf16le");
    name.copy(file, offset);
    file.writeUInt16LE(name.length, offset + 64);
    file.writeInt8(entry.type, offset + 66);
    file.writeInt32LE(entry.start, offset + 116);
    file.writeInt32LE(entry.size, offset + 120);
  }

  for (const [secId, values] of Object.entries(options.extraSectors ?? {})) {
    values.forEach((value, index) => {
      file.writeInt32LE(value, (Number(secId) + 1) * SECTOR + index * 4);
    });
  }
  return file;
}

describe("validateOleCompoundFile", () => {
  it("accepts a well-formed file, including a chain that ends on a self-reference", () => {
    expect(() => validateOleCompoundFile(oleFile())).not.toThrow();
    // word-extractor stops a chain at a sector that points to itself, so this is not a loop.
    expect(() =>
      validateOleCompoundFile(oleFile({ fat: { 9: 9 } })),
    ).not.toThrow();
  });

  it("rejects a two-sector FAT cycle in a stream chain", () => {
    expect(() => validateOleCompoundFile(oleFile({ fat: { 3: 2 } }))).toThrow(
      /loops back on itself/,
    );
  });

  it("rejects a cycle in the short-sector allocation table", () => {
    const file = oleFile({
      sectors: 11,
      header: { 60: 10, 64: 1 },
      fat: { 10: END_OF_CHAIN },
      entries: [
        { name: "Root Entry", type: 5, child: 1, start: 2, size: 4096 },
        { name: "WordDocument", type: 2, start: 0, size: 100 },
      ],
      extraSectors: { 10: [1, 0] },
    });
    expect(() => validateOleCompoundFile(file)).toThrow(/loops back on itself/);
  });

  it("rejects header sizes and chains that do not fit in the file", () => {
    const badShift = oleFile();
    badShift.writeUInt16LE(2, 30);
    expect(() => validateOleCompoundFile(badShift)).toThrow(
      /unsupported sector size/,
    );
    expect(() =>
      validateOleCompoundFile(oleFile({ header: { 44: 0x7fffffff } })),
    ).toThrow(/larger than the file/);
    expect(() => validateOleCompoundFile(oleFile({ fat: { 9: 50 } }))).toThrow(
      /past the end of the file/,
    );
  });

  it("rejects a directory entry that is reachable twice", () => {
    const file = oleFile({
      entries: [
        { name: "Root Entry", type: 5, child: 1, start: END_OF_CHAIN, size: 0 },
        {
          name: "WordDocument",
          type: 2,
          left: 2,
          right: 2,
          start: 2,
          size: 4096,
        },
        { name: "Data", type: 2, start: END_OF_CHAIN, size: 0 },
      ],
    });
    expect(() => validateOleCompoundFile(file)).toThrow(/directory tree/);
  });
});
