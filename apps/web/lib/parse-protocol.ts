import {
  createHash,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { MAX_MULTIPART_UPLOAD_FILE_SIZE } from "@/lib/upload-constants";

// The contract between the upload routes and the parse-only function (app/api/internal/parse):
// where it lives, how a call is signed, and the shapes of its request and answer. It imports only
// node:crypto, zod and the dependency-free upload limits, so both sides can share it without
// pulling in parsers or the database.

export const PARSE_ROUTE = "/api/internal/parse";

/**
 * A call names either a stored object (a JSON body) or carries the validated bytes themselves: a
 * body of this type, with the signed request in PARSE_BYTES_HEADER. Chat attachments use bytes,
 * because they are never in object storage.
 */
export const PARSE_BYTES_CONTENT_TYPE = "application/octet-stream";
export const PARSE_BYTES_HEADER = "x-signloop-parse";

/** The largest body a bytes call may carry: the multipart upload limit chat attachments share. */
export const MAX_PARSE_BYTES = MAX_MULTIPART_UPLOAD_FILE_SIZE;

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

// A SHA-256 digest (the HMAC signature, or a bytes call's body hash) in unpadded base64url.
const sha256Base64url = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const parseRequestSchema = z.object({
  storageKey: z.string().min(1).max(2048),
  mimeType: z.string().min(1).max(255),
  expiresAt: z.number().int().positive(),
  signature: sha256Base64url,
});
export type SignedParseRequest = z.infer<typeof parseRequestSchema>;

export const bytesParseRequestSchema = z.object({
  mimeType: z.string().min(1).max(255),
  expiresAt: z.number().int().positive(),
  bodySha256: sha256Base64url,
  signature: sha256Base64url,
});
export type SignedBytesParseRequest = z.infer<
  typeof bytesParseRequestSchema
>;

/**
 * Derive the parse-call key from WORKOS_COOKIE_PASSWORD, a server-only secret every deployment
 * already has. HKDF with its own label keeps it independent of the session-cookie key.
 */
function parseKey(): Buffer {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new Error("WORKOS_COOKIE_PASSWORD is not configured");
  return Buffer.from(hkdfSync("sha256", secret, "", PARSE_KEY_INFO, 32));
}

// JSON keeps the fields unambiguous whatever characters they contain. A stored call signs four
// fields and a bytes call five, so neither signature verifies as the other.
function storedSignatureFor(
  key: Buffer,
  input: { storageKey: string; mimeType: string; expiresAt: number },
): Buffer {
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

function bytesSignatureFor(
  key: Buffer,
  input: { mimeType: string; expiresAt: number; bodySha256: string },
): Buffer {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        `POST ${PARSE_ROUTE}`,
        "bytes",
        input.bodySha256,
        input.mimeType,
        input.expiresAt,
      ]),
    )
    .digest();
}

function bodyDigest(body: Uint8Array): Buffer {
  return createHash("sha256").update(body).digest();
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
    signature: storedSignatureFor(parseKey(), {
      ...input,
      expiresAt,
    }).toString("base64url"),
  };
}

/** Sign a call that sends these exact bytes to be parsed as one MIME type. */
export function signBytesParseRequest(
  input: { mimeType: string; body: Uint8Array },
  now = Date.now(),
): SignedBytesParseRequest {
  const unsigned = {
    mimeType: input.mimeType,
    expiresAt: now + PARSE_SIGNATURE_TTL_MS,
    bodySha256: bodyDigest(input.body).toString("base64url"),
  };
  return {
    ...unsigned,
    signature: bytesSignatureFor(parseKey(), unsigned).toString("base64url"),
  };
}

/** A bytes call's signed request as a header value (base64url JSON, so always ASCII). */
export function encodeBytesParseHeader(
  request: SignedBytesParseRequest,
): string {
  return Buffer.from(JSON.stringify(request)).toString("base64url");
}

/** The signed request in a bytes call's header, or null when it is missing or malformed. */
export function decodeBytesParseHeader(
  value: string | null,
): SignedBytesParseRequest | null {
  // A well-formed request is a few hundred bytes; anything far larger is not one.
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  try {
    const parsed = bytesParseRequestSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function verifySignature(
  expiresAt: number,
  signature: string,
  expectedFor: (key: Buffer) => Buffer,
  now: number,
): boolean {
  if (expiresAt < now || expiresAt > now + PARSE_SIGNATURE_TTL_MS) {
    return false;
  }
  let key: Buffer;
  try {
    key = parseKey();
  } catch {
    return false;
  }
  const expected = expectedFor(key);
  const actual = Buffer.from(signature, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
  return verifySignature(
    request.expiresAt,
    request.signature,
    (key) => storedSignatureFor(key, request),
    now,
  );
}

/**
 * Whether a bytes call's request was signed by this app for this MIME type and body hash, and has
 * not expired, by the same rules as verifyParseRequest. It runs before the body is read; the body
 * must then pass bytesMatchParseRequest.
 */
export function verifyBytesParseRequest(
  request: SignedBytesParseRequest,
  now = Date.now(),
): boolean {
  return verifySignature(
    request.expiresAt,
    request.signature,
    (key) => bytesSignatureFor(key, request),
    now,
  );
}

/** Whether a body is the one a verified bytes request was signed for. */
export function bytesMatchParseRequest(
  request: SignedBytesParseRequest,
  body: Uint8Array,
): boolean {
  const expected = bodyDigest(body);
  const actual = Buffer.from(request.bodySha256, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
