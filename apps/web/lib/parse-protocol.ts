import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// The contract between the upload routes and the parse-only function (app/api/internal/parse):
// where it lives, how a call is signed, and the shapes of its request and answer. It imports only
// node:crypto and zod, so both sides can share it without pulling in parsers or the database.

export const PARSE_ROUTE = "/api/internal/parse";

/** How long a signed parse request stays valid. */
export const PARSE_SIGNATURE_TTL_MS = 60_000;

// HKDF label for the parse-call key. Changing it invalidates outstanding signatures, which live
// for at most a minute.
const PARSE_KEY_INFO = "signloop/internal-parse/v1";

export const PARSE_ERROR_KINDS = [
  "limit",
  "content",
  "unavailable",
  "failed",
] as const;
export type ParseErrorKind = (typeof PARSE_ERROR_KINDS)[number];

const EXTRACTION_METHODS = [
  "pdf_parse",
  "pdf_scanned",
  "tesseract_ocr",
  "word_parse",
  "plain_text",
] as const;

/**
 * A parse result. Errors carry a message written by the server for the uploader, never text from
 * the file: `limit` and `content` are the uploader's to fix (422), `unavailable` is transient
 * (503), and `failed` means the parser rejected the file, whose cause stays in the server log.
 */
export const parseOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    text: z.string(),
    method: z.enum(EXTRACTION_METHODS),
    confidence: z.number().nullable(),
    sparseTextPages: z.array(z.number().int().positive()),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(PARSE_ERROR_KINDS),
    message: z.string().max(1000),
  }),
]);
export type ParseOutcome = z.infer<typeof parseOutcomeSchema>;

export const parseRequestSchema = z.object({
  storageKey: z.string().min(1).max(2048),
  mimeType: z.string().min(1).max(255),
  expiresAt: z.number().int().positive(),
  // An HMAC-SHA256 in unpadded base64url.
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type SignedParseRequest = z.infer<typeof parseRequestSchema>;

/**
 * Derive the parse-call key from WORKOS_COOKIE_PASSWORD, a server-only secret every deployment
 * already has. HKDF with its own label keeps it independent of the session-cookie key.
 */
function parseKey(): Buffer {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new Error("WORKOS_COOKIE_PASSWORD is not configured");
  return Buffer.from(hkdfSync("sha256", secret, "", PARSE_KEY_INFO, 32));
}

function signatureFor(
  key: Buffer,
  input: { storageKey: string; mimeType: string; expiresAt: number },
): Buffer {
  // JSON keeps the fields unambiguous whatever characters they contain.
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        `POST ${PARSE_ROUTE}`,
        input.storageKey,
        input.mimeType,
        input.expiresAt,
      ]),
    )
    .digest();
}

/** Sign a call that asks the parse function to parse one stored object as one MIME type. */
export function signParseRequest(
  input: { storageKey: string; mimeType: string },
  now = Date.now(),
): SignedParseRequest {
  const expiresAt = now + PARSE_SIGNATURE_TTL_MS;
  return {
    storageKey: input.storageKey,
    mimeType: input.mimeType,
    expiresAt,
    signature: signatureFor(parseKey(), { ...input, expiresAt }).toString(
      "base64url",
    ),
  };
}

/**
 * Whether a parse call was signed by this app for exactly this object and type, and has not
 * expired. An expiry further out than one TTL is refused too, so a signature cannot be minted to
 * last longer. False, never an exception, when the key is not configured.
 */
export function verifyParseRequest(
  request: SignedParseRequest,
  now = Date.now(),
): boolean {
  if (
    request.expiresAt < now ||
    request.expiresAt > now + PARSE_SIGNATURE_TTL_MS
  ) {
    return false;
  }
  let key: Buffer;
  try {
    key = parseKey();
  } catch {
    return false;
  }
  const expected = signatureFor(key, request);
  const actual = Buffer.from(request.signature, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
