import { parseDocument, parseStoredDocument } from "@/lib/document-parser";
import {
  bytesMatchParseRequest,
  decodeBytesParseHeader,
  MAX_PARSE_BYTES,
  PARSE_BYTES_CONTENT_TYPE,
  PARSE_BYTES_HEADER,
  parseRequestSchema,
  verifyBytesParseRequest,
  verifyParseRequest,
  type ParseOutcome,
} from "@/lib/parse-protocol";

// The parse-only function. Upload routes store a file, then ask this route to read it back and run
// the parsers; chat attachments, which are never stored first, send their validated bytes instead.
// Either way a hostile or pathological document exhausts this function's memory and time rather
// than the instance serving the user's other requests. It imports only the parsers, object storage
// and the signing protocol: no database, session or model clients.

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

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const parseSignal = (req: Request) =>
  AbortSignal.any([req.signal, AbortSignal.timeout(PARSE_DEADLINE_MS)]);

/** A stored object named in a signed JSON body. Null when the call is refused. */
async function parseStoredCall(req: Request): Promise<ParseOutcome | null> {
  const body = await readBoundedBody(req, MAX_REQUEST_BYTES);
  if (body === null) return null;
  let request;
  try {
    const parsed = parseRequestSchema.safeParse(
      JSON.parse(body.toString("utf8")),
    );
    if (!parsed.success) return null;
    request = parsed.data;
  } catch {
    return null;
  }
  if (!verifyParseRequest(request)) return null;
  return parseStoredDocument(
    request.storageKey,
    request.mimeType,
    parseSignal(req),
  );
}

/**
 * Bytes sent as the body, signed in a header. The signature is checked before the body is read,
 * and the body must be within the chat-attachment limit and hash to what was signed. Null when
 * the call is refused.
 */
async function parseBytesCall(req: Request): Promise<ParseOutcome | null> {
  const request = decodeBytesParseHeader(req.headers.get(PARSE_BYTES_HEADER));
  if (!request || !verifyBytesParseRequest(request)) return null;
  const body = await readBoundedBody(req, MAX_PARSE_BYTES);
  if (body === null || !bytesMatchParseRequest(request, body)) return null;
  return parseDocument(body, request.mimeType, parseSignal(req));
}

export async function POST(req: Request): Promise<Response> {
  const contentType = req.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const outcome =
    contentType === PARSE_BYTES_CONTENT_TYPE
      ? await parseBytesCall(req)
      : await parseStoredCall(req);
  if (outcome === null) return notFound();

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
