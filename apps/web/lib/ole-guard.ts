const OLE_SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");
const HEADER_BYTES = 512;
const HEADER_MSAT_ENTRIES = 109;
const DIRECTORY_ENTRY_BYTES = 128;
const STORAGE_ENTRY = 1;
const STREAM_ENTRY = 2;
const ROOT_ENTRY = 5;
const NO_SECTOR = -1;
const NO_SIBLING = -1;

function invalid(reason: string): Error {
  return new Error(`Invalid compound document: ${reason}`);
}

/** word-extractor sends every buffer that starts with D0 CF to its OLE parser. */
export function isOleCompoundFile(buffer: Buffer): boolean {
  return buffer[0] === 0xd0 && buffer[1] === 0xcf;
}

/**
 * Follows sector chains the way word-extractor's AllocationTable.getSecIdChain does: a chain ends
 * at a negative id, at an id past the table, or at a sector that points to itself. That method has
 * no other exit, so a longer cycle loops synchronously until the heap is exhausted. `check` rejects
 * such a cycle instead. It remembers sectors already proven to reach an end, so checking many
 * chains costs one pass over the table.
 */
function createChainWalker(table: Int32Array, sectorLimit: number) {
  const ON_WALK = 1;
  const REACHES_END = 2;
  const state = new Uint8Array(table.length);
  const nextSector = (secId: number) => {
    const next = table[secId] ?? NO_SECTOR;
    return next === secId ? NO_SECTOR : next;
  };

  const check = (start: number) => {
    const walked: number[] = [];
    for (let secId = start; secId > NO_SECTOR; secId = nextSector(secId)) {
      if (secId >= sectorLimit) {
        throw invalid("sector chain runs past the end of the file");
      }
      if (secId >= table.length || state[secId] === REACHES_END) break;
      if (state[secId] === ON_WALK) {
        throw invalid("sector chain loops back on itself");
      }
      state[secId] = ON_WALK;
      walked.push(secId);
    }
    for (const secId of walked) state[secId] = REACHES_END;
  };

  const chain = (start: number): number[] => {
    check(start);
    const secIds: number[] = [];
    for (let secId = start; secId > NO_SECTOR; secId = nextSector(secId)) {
      secIds.push(secId);
    }
    return secIds;
  };

  return { check, chain };
}

/**
 * Validate the OLE structure that word-extractor 1.0.4 trusts before it parses a legacy .doc. This
 * mirrors the reads it makes (header, allocation tables, directory tree, and the chains of the
 * root-level streams it can open) and rejects loops, tables larger than the file, and chains of
 * regular sectors that leave the file, so its parse stays bounded by the upload size.
 *
 * @throws Error when the structure would make the parser loop or read outside the file.
 */
export function validateOleCompoundFile(buffer: Buffer): void {
  if (
    buffer.length < HEADER_BYTES ||
    !buffer.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)
  ) {
    throw new Error("Not a valid compound document");
  }
  const sectorShift = buffer.readUInt16LE(30);
  if (
    (sectorShift !== 9 && sectorShift !== 12) ||
    buffer.readUInt16LE(32) !== 6
  ) {
    throw invalid("unsupported sector size");
  }
  const sectorSize = 2 ** sectorShift;
  const entriesPerSector = sectorSize / 4;
  // Sector n starts at (n + 1) * sectorSize. A final partial sector is read zero-padded.
  const sectorCount = Math.max(0, Math.ceil(buffer.length / sectorSize) - 1);
  const satSectorCount = buffer.readInt32LE(44);
  const miniSatSectorCount = buffer.readInt32LE(64);
  const msatSectorCount = buffer.readInt32LE(72);
  if (
    [satSectorCount, miniSatSectorCount, msatSectorCount].some(
      (count) => count < 0 || count > sectorCount,
    )
  ) {
    throw invalid("allocation table is larger than the file");
  }

  const readSector = (secId: number): Buffer => {
    if (secId < 0 || secId >= sectorCount) {
      throw invalid("sector is outside the file");
    }
    const start = (secId + 1) * sectorSize;
    const sector = buffer.subarray(start, start + sectorSize);
    if (sector.length === sectorSize) return sector;
    const padded = Buffer.alloc(sectorSize);
    sector.copy(padded);
    return padded;
  };
  const readTable = (secIds: number[]): Int32Array => {
    const table = new Int32Array(secIds.length * entriesPerSector);
    secIds.forEach((secId, index) => {
      const sector = readSector(secId);
      for (let entry = 0; entry < entriesPerSector; entry++) {
        table[index * entriesPerSector + entry] = sector.readInt32LE(entry * 4);
      }
    });
    return table;
  };

  const satSectors: number[] = [];
  for (
    let index = 0;
    index < Math.min(satSectorCount, HEADER_MSAT_ENTRIES);
    index++
  ) {
    satSectors.push(buffer.readInt32LE(76 + index * 4));
  }
  if (satSectorCount > HEADER_MSAT_ENTRIES && msatSectorCount > 0) {
    let msatSector = buffer.readInt32LE(68);
    for (let index = 0; index < msatSectorCount; index++) {
      const sector = readSector(msatSector);
      for (
        let offset = 0;
        offset < sectorSize - 4 && satSectors.length < satSectorCount;
        offset += 4
      ) {
        satSectors.push(sector.readInt32LE(offset));
      }
      msatSector = sector.readInt32LE(sectorSize - 4);
    }
  }
  if (satSectors.length !== satSectorCount) {
    throw invalid("sector allocation table is incomplete");
  }

  const sat = createChainWalker(readTable(satSectors), sectorCount);
  const miniSatSectors = sat.chain(buffer.readInt32LE(60));
  if (miniSatSectors.length !== miniSatSectorCount) {
    throw invalid("short sector allocation table does not match its chain");
  }
  // Short sectors live inside the root entry's stream, so they are not checked against file size.
  const miniSat = createChainWalker(
    readTable(miniSatSectors),
    Number.POSITIVE_INFINITY,
  );

  const directory = Buffer.concat(
    sat.chain(buffer.readInt32LE(48)).map((secId) => readSector(secId)),
  );
  const entryCount = directory.length / DIRECTORY_ENTRY_BYTES;
  const entryType = (entry: number) =>
    directory.readInt8(entry * DIRECTORY_ENTRY_BYTES + 66);
  const entryField = (entry: number, offset: number) =>
    directory.readInt32LE(entry * DIRECTORY_ENTRY_BYTES + offset);

  let root = -1;
  for (let entry = 0; entry < entryCount; entry++) {
    if (entryType(entry) === ROOT_ENTRY) {
      root = entry;
      break;
    }
  }
  if (root < 0) throw invalid("directory has no root entry");

  // word-extractor builds the storage hierarchy recursively without tracking visited entries, so
  // a shared or cyclic sibling link would recurse forever or exponentially. Each entry may be
  // reached once.
  const reached = new Uint8Array(entryCount);
  reached[root] = 1;
  const rootStreams: number[] = [];
  const storages = [root];
  for (
    let storage = storages.pop();
    storage !== undefined;
    storage = storages.pop()
  ) {
    const pending: number[] = [];
    const firstChild = entryField(storage, 76);
    if (firstChild > NO_SIBLING) pending.push(firstChild);
    for (
      let entry = pending.pop();
      entry !== undefined;
      entry = pending.pop()
    ) {
      if (entry < 0 || entry >= entryCount || reached[entry]) {
        throw invalid("directory tree is malformed");
      }
      reached[entry] = 1;
      const type = entryType(entry);
      if (type === STORAGE_ENTRY) storages.push(entry);
      if (type === STREAM_ENTRY && storage === root) rootStreams.push(entry);
      for (const sibling of [entryField(entry, 68), entryField(entry, 72)]) {
        if (sibling !== NO_SIBLING) pending.push(sibling);
      }
    }
  }

  sat.check(entryField(root, 116));
  const shortStreamMax = buffer.readInt32LE(56);
  for (const stream of rootStreams) {
    const table = entryField(stream, 120) < shortStreamMax ? miniSat : sat;
    table.check(entryField(stream, 116));
  }
}
