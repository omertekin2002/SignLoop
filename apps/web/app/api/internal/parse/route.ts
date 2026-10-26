import { parseStoredDocument } from "@/lib/document-parser";
import { parseRequestSchema, verifyParseRequest } from "@/lib/parse-protocol";

// The parse-only function. Upload routes store a file, then ask this route to read it back and run
// the parsers, so a hostile or pathological document exhausts this function's memory and time
// rather than the instance serving the user's other requests. It imports only the parsers, object
// storage and the signing protocol: no database, session or model clients.

// Its own duration, below the upload routes' 180 s, also keeps Vercel from grouping it with them.
// OCR budgets 60 s for worker start plus 90 s for recognition.
export const maxDuration = 160;

const PARSE_DEADLINE_MS = 150_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const RESPONSE_CHUNK_BYTES = 64 * 1024;

// Every refusal looks like a missing route, so callers without a valid signature learn nothing.
const notFound = () =>
  new Response("Not Found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

async function readSmallBody(req: Request): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = await readSmallBody(req);
  if (body === null) return notFound();
  let request;
  try {
    const parsed = parseRequestSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return notFound();
    request = parsed.data;
  } catch {
    return notFound();
  }
  if (!verifyParseRequest(request)) return notFound();

  const signal = AbortSignal.any([
    req.signal,
    AbortSignal.timeout(PARSE_DEADLINE_MS),
  ]);
  const outcome = await parseStoredDocument(
    request.storageKey,
    request.mimeType,
    signal,
  );

  // Streamed, because extracted text can pass Vercel's 4.5 MB limit on buffered response bodies.
  const encoded = new TextEncoder().encode(JSON.stringify(outcome));
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= encoded.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoded.subarray(offset, offset + RESPONSE_CHUNK_BYTES),
        );
        offset += RESPONSE_CHUNK_BYTES;
      },
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
