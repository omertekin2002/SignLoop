import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** Bytes for one archive file, or null when the source no longer exists. */
export type ExportFileSource = () => Promise<ReadableStream<Uint8Array> | Uint8Array | null>;

type ArchiveFile = { path: string; open: ExportFileSource };

const MAX_SEGMENT_LENGTH = 120;
// Device names Windows refuses as file names, with or without an extension.
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Make one user-supplied name safe as a single archive path segment: no separators, no `.`/`..`,
 * no control or Windows-invalid characters, no reserved device names, and a bounded length that
 * keeps the extension.
 */
export function sanitizeArchiveSegment(name: string, fallback = "file"): string {
  let clean = name
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- control characters are what this removes
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!clean) clean = fallback;
  if (RESERVED_WINDOWS_NAME.test(clean)) clean = `_${clean}`;
  if (clean.length > MAX_SEGMENT_LENGTH) {
    const dot = clean.lastIndexOf(".");
    const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
    clean = clean.slice(0, MAX_SEGMENT_LENGTH - extension.length).trimEnd() + extension;
  }
  return clean;
}

function withSuffix(name: string, counter: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${counter})${name.slice(dot)}`
    : `${name} (${counter})`;
}

/**
 * A ZIP written as a stream. Files are registered up front, so the JSON documents can name their
 * archive paths, and each file's bytes are read only when the stream reaches it.
 */
export class ExportArchive {
  private readonly files: ArchiveFile[] = [];
  // Lower-cased, because macOS and Windows extract case-insensitively.
  private readonly taken = new Set<string>();
  private readonly root: string;

  constructor(root: string) {
    this.root = sanitizeArchiveSegment(root, "export");
  }

  /**
   * Register a file and return its unique, sanitized path, relative to the archive's root folder.
   */
  addFile(folders: readonly string[], name: string, open: ExportFileSource): string {
    const directory = folders.map((folder) => sanitizeArchiveSegment(folder, "folder")).join("/");
    const base = sanitizeArchiveSegment(name);
    const join = (file: string) => (directory ? `${directory}/${file}` : file);
    let path = join(base);
    for (let counter = 2; this.taken.has(path.toLowerCase()); counter += 1) {
      path = join(withSuffix(base, counter));
    }
    this.taken.add(path.toLowerCase());
    this.files.push({ path, open });
    return path;
  }

  /**
   * Stream the archive under its root folder: `documents` as JSON, then every registered file,
   * then a README from `readme`, which receives the paths of files whose source was gone.
   */
  stream(input: {
    modifiedAt: Date;
    documents: Record<string, unknown>;
    readme: (missing: string[]) => string;
  }): ReadableStream<Uint8Array> {
    const chunks = this.chunks(input);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await chunks.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          // Headers are already sent, so the download ends early; record why.
          console.error("Failed to stream export archive:", error);
          throw error;
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    });
  }

  private async *chunks(input: {
    modifiedAt: Date;
    documents: Record<string, unknown>;
    readme: (missing: string[]) => string;
  }): AsyncGenerator<Uint8Array, void, undefined> {
    const output: Uint8Array[] = [];
    let failure: Error | null = null;
    const zip = new Zip((error, chunk) => {
      if (error) failure = error;
      else if (chunk.length) output.push(chunk);
    });
    function* drain() {
      if (failure) throw failure;
      while (output.length) yield output.shift()!;
    }
    const entry = (path: string, compress: boolean): ZipDeflate | ZipPassThrough => {
      const name = `${this.root}/${path}`;
      const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      file.mtime = input.modifiedAt;
      zip.add(file);
      return file;
    };

    for (const [name, value] of Object.entries(input.documents)) {
      entry(name, true).push(strToU8(`${JSON.stringify(value, null, 2)}\n`), true);
      yield* drain();
    }

    const missing: string[] = [];
    for (const { path, open } of this.files) {
      const source = await open();
      if (source === null) {
        missing.push(path);
        continue;
      }
      // Uploaded documents are mostly compressed already; storing them keeps CPU use low.
      const file = entry(path, false);
      if (source instanceof Uint8Array) {
        file.push(source, true);
        yield* drain();
        continue;
      }
      const reader = source.getReader();
      let finished = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          file.push(value);
          yield* drain();
        }
        finished = true;
      } finally {
        // A failed or abandoned download must not leave the file or connection open.
        if (!finished) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      file.push(new Uint8Array(0), true);
      yield* drain();
    }

    entry("README.txt", true).push(strToU8(input.readme(missing)), true);
    zip.end();
    yield* drain();
  }
}
