import { withAbort } from "@repo/chat-engine/bounded-response";
import { MAX_EXTRACTED_TEXT_LENGTH } from "@/lib/upload-constants";
import {
  PARSE_ROUTE,
  parseOutcomeSchema,
  signParseRequest,
  type ParseOutcome,
} from "@/lib/parse-protocol";

// Calls the parse-only function (app/api/internal/parse) over HTTP on this app's own deployment.

const UNAVAILABLE: ParseOutcome = {
  ok: false,
  kind: "unavailable",
  message: "Text extraction is unavailable right now. Please try again shortly.",
};
// The largest answer the parse function can give: the extracted-text bound with every UTF-16 unit
// JSON-escaped as \uXXXX, plus the other fields.
const MAX_RESPONSE_BYTES = MAX_EXTRACTED_TEXT_LENGTH * 6 + 64 * 1024;

/**
 * Where to reach the parse function. On Vercel it is this deployment's own URL, never one derived
 * from the request's Host header; Deployment Protection covers that URL, so the call carries the
 * project's automation bypass secret when Vercel provides one. Elsewhere (local development, `next
 * start`) it is the origin the request arrived on, served by the same process.
 */
function parseTarget(req: Request): { url: URL; headers: Headers } {
  const headers = new Headers({ "Content-Type": "application/json" });
  const deployment = process.env.VERCEL_URL;
  if (deployment) {
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) headers.set("x-vercel-protection-bypass", bypass);
    return { url: new URL(PARSE_ROUTE, `https://${deployment}`), headers };
  }
  return { url: new URL(PARSE_ROUTE, req.url), headers };
}

async function readBoundedText(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Ask the parse function to parse a stored upload whose MIME type and signature were validated.
 * Transport failures become an `unavailable` outcome; aborting `signal` cancels the call, and the
 * caller checks it.
 */
export async function requestParse(input: {
  req: Request;
  storageKey: string;
  mimeType: string;
  signal: AbortSignal;
}): Promise<ParseOutcome> {
  try {
    const { url, headers } = parseTarget(input.req);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(
        signParseRequest({
          storageKey: input.storageKey,
          mimeType: input.mimeType,
        }),
      ),
      signal: input.signal,
      redirect: "manual",
      cache: "no-store",
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      console.error(`Parse function answered ${response.status}`);
      return UNAVAILABLE;
    }
    const body = await readBoundedText(response, input.signal);
    const parsed = body === null ? null : parseOutcomeSchema.safeParse(JSON.parse(body));
    if (!parsed?.success) {
      console.error("Parse function returned an invalid answer");
      return UNAVAILABLE;
    }
    return parsed.data;
  } catch (error: unknown) {
    if (!input.signal.aborted) console.error("Parse function call failed:", error);
    return UNAVAILABLE;
  }
}
