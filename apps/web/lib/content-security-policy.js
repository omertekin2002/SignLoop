// The Content Security Policy the web app sends, shared by next.config.js (the header) and the
// tests. Plain JavaScript so the Next.js config can import it without a compiler.
//
// It is sent as Content-Security-Policy-Report-Only for now: browsers report violations to
// CSP_REPORT_PATH and block nothing. Enforcing it is a later change, once the reports are clean.
// The policy is static (no nonce), so pages can stay statically rendered.

/** Where browsers POST violation reports (app/api/csp-report/route.ts). */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * The origin `upload()` from `@vercel/blob/client` (lib/upload-client.ts) PUTs file bytes to. In
 * @vercel/blob 2.6.1, dist/chunk-CIIQSN42.js sends every client upload through `requestApi`,
 * whose `getApiUrl` builds `${VERCEL_BLOB_API_URL || NEXT_PUBLIC_VERCEL_BLOB_API_URL ||
 * defaultVercelBlobApiUrl}${pathname}` with `defaultVercelBlobApiUrl = "https://vercel.com/api/blob"`.
 * SignLoop sets neither variable, and multipart uploads use the same API. The client token comes
 * from our own `/api/uploads`, which 'self' covers.
 */
export const VERCEL_BLOB_UPLOAD_ORIGIN = "https://vercel.com";

/**
 * The policy's directives. `dev` adds what `next dev` needs: React uses eval() in development to
 * rebuild server error stacks in the browser, and never in production builds.
 * @param {{ dev: boolean }} options
 * @returns {Record<string, string[]>}
 */
export function contentSecurityPolicyDirectives({ dev }) {
  return {
    "default-src": ["'self'"],
    // Next.js inlines the scripts that bootstrap and hydrate each page.
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    // Server-rendered style attributes and the inline styles of Next.js and the UI libraries.
    "style-src": ["'self'", "'unsafe-inline'"],
    // data: and blob: URLs the app creates for images and downloads.
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", VERCEL_BLOB_UPLOAD_ORIGIN],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'none'"],
    // Forms submit in script; sign-in and sign-out leave for WorkOS through links and
    // client-side navigations, which form-action does not govern.
    "form-action": ["'self'"],
    "report-uri": [CSP_REPORT_PATH],
  };
}

/**
 * The policy as a header value.
 * @param {{ dev: boolean }} options
 * @returns {string}
 */
export function contentSecurityPolicy({ dev }) {
  return Object.entries(contentSecurityPolicyDirectives({ dev }))
    .map(([directive, sources]) => [directive, ...sources].join(" "))
    .join("; ");
}
