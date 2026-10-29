// Receives Content Security Policy violation reports (lib/content-security-policy.js). Browsers
// send them without credentials, so the route needs no auth or database: it logs one compact line
// per violation and answers 204. It never echoes or logs a report verbatim, since reports can
// carry page URLs with query strings and snippets of the page.

/** Larger bodies are refused with 413. A browser's report is well under 2 KiB. */
const CSP_REPORT_MAX_BYTES = 16 * 1024;

// The report-uri format and the Reporting API format.
const REPORT_MEDIA_TYPES = new Set(["application/csp-report", "application/reports+json"]);

// A batch can hold many violations; the rest of a large batch is counted, not logged.
const MAX_LOGGED_VIOLATIONS = 20;

const MAX_LOGGED_VALUE_LENGTH = 200;

const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

type Violation = { directive: string; blocked: string; page: string };

class BodyTooLargeError extends Error {}

export async function POST(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!mediaType || !REPORT_MEDIA_TYPES.has(mediaType)) return empty(415);

  let report: unknown;
  try {
    report = JSON.parse(await readBoundedText(request, CSP_REPORT_MAX_BYTES));
  } catch (error) {
    return empty(error instanceof BodyTooLargeError ? 413 : 400);
  }

  const violations =
    mediaType === "application/csp-report" ? fromReportUri(report) : fromReportingApi(report);
  for (const { directive, blocked, page } of violations.slice(0, MAX_LOGGED_VIOLATIONS))
    console.warn(`CSP violation: directive=${directive} blocked=${blocked} page=${page}`);
  if (violations.length > MAX_LOGGED_VIOLATIONS)
    console.warn(`CSP violation: ${violations.length - MAX_LOGGED_VIOLATIONS} more in the same report`);
  return empty(204);
}

function empty(status: number) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new BodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// `{"csp-report": {"effective-directive": ..., "blocked-uri": ..., "document-uri": ...}}`
function fromReportUri(report: unknown): Violation[] {
  const body = field(report, "csp-report");
  if (!isRecord(body)) return [];
  return [
    toViolation(
      field(body, "effective-directive") ?? field(body, "violated-directive"),
      field(body, "blocked-uri"),
      field(body, "document-uri"),
    ),
  ];
}

// `[{"type": "csp-violation", "url": ..., "body": {"effectiveDirective": ..., "blockedURL": ...}}]`
function fromReportingApi(report: unknown): Violation[] {
  if (!Array.isArray(report)) return [];
  return report.flatMap((entry) => {
    const body = field(entry, "body");
    if (field(entry, "type") !== "csp-violation" || !isRecord(body)) return [];
    return [
      toViolation(
        field(body, "effectiveDirective"),
        field(body, "blockedURL"),
        field(body, "documentURL") ?? field(entry, "url"),
      ),
    ];
  });
}

function toViolation(directive: unknown, blocked: unknown, page: unknown): Violation {
  return {
    directive: directiveName(directive),
    blocked: blockedSource(blocked),
    page: documentPath(page),
  };
}

// Directive names are lowercase words with dashes; the effective one may carry a value.
function directiveName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().split(/\s/)[0] : undefined;
  return name && /^[a-z-]{1,40}$/.test(name) ? name : "unknown";
}

// A web URL is reduced to its origin and any other URL to its scheme (data:, blob:); keywords
// such as `inline` and `eval` are kept.
function blockedSource(value: unknown): string {
  if (typeof value !== "string" || value === "") return "unknown";
  if (/^[a-z-]{1,40}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return WEB_PROTOCOLS.has(url.protocol) ? truncate(url.origin) : url.protocol;
  } catch {
    return "unknown";
  }
}

// The document's path, without its query string or fragment.
function documentPath(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  try {
    return truncate(new URL(value).pathname);
  } catch {
    return "unknown";
  }
}

function truncate(value: string): string {
  return value.length > MAX_LOGGED_VALUE_LENGTH
    ? `${value.slice(0, MAX_LOGGED_VALUE_LENGTH)}…`
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
