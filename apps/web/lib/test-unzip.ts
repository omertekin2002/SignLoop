import yauzl from "yauzl";

// Test helper: read a whole ZIP into memory, keyed by entry name, so tests can compare bytes.
export async function unzip(
  archive: Uint8Array | ReadableStream<Uint8Array> | Response,
): Promise<Map<string, Buffer>> {
  const buffer =
    archive instanceof Uint8Array
      ? Buffer.from(archive)
      : Buffer.from(await (archive instanceof Response ? archive : new Response(archive)).arrayBuffer());
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (error, file) =>
      error ? reject(error) : resolve(file),
    ),
  );
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          if (entries.has(entry.fileName)) return reject(new Error(`Duplicate entry ${entry.fileName}`));
          entries.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return entries;
}

export function json(entries: Map<string, Buffer>, name: string): unknown {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Missing ${name}`);
  return JSON.parse(entry.toString("utf8"));
}
