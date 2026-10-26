import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestParse } from "./parse-client";
import { parseRequestSchema, verifyParseRequest } from "./parse-protocol";

const STORAGE_KEY = "uploads/0b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d";
const UNAVAILABLE = {
  ok: false,
  kind: "unavailable",
  message: "Text extraction is unavailable right now. Please try again shortly.",
};
const parsed = {
  ok: true,
  text: "This lease renews automatically.",
  method: "pdf_parse",
  confidence: null,
  sparseTextPages: [],
};

const fetchMock = vi.fn();
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "a-test-cookie-password-of-32-chars!!");
  vi.stubEnv("VERCEL_URL", "");
  vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
  vi.stubGlobal("fetch", fetchMock);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const call = (signal = new AbortController().signal) =>
  requestParse({
    req: new Request("http://localhost:3000/api/contracts/x/upload", { method: "POST" }),
    storageKey: STORAGE_KEY,
    mimeType: "application/pdf",
    signal,
  });

describe("requestParse", () => {
  it("posts a signed request to the parse route on the request's origin outside Vercel", async () => {
    fetchMock.mockResolvedValue(Response.json(parsed));
    const signal = new AbortController().signal;

    expect(await call(signal)).toEqual(parsed);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:3000/api/internal/parse");
    expect(init).toMatchObject({ method: "POST", signal, redirect: "manual", cache: "no-store" });
    expect(new Headers(init.headers).has("x-vercel-protection-bypass")).toBe(false);
    const body = parseRequestSchema.parse(JSON.parse(init.body));
    expect(body).toMatchObject({ storageKey: STORAGE_KEY, mimeType: "application/pdf" });
    expect(verifyParseRequest(body)).toBe(true);
  });

  it("calls this deployment's own URL on Vercel with the automation bypass, ignoring the Host", async () => {
    vi.stubEnv("VERCEL_URL", "signloop-abc123.vercel.app");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bypass-value");
    fetchMock.mockResolvedValue(Response.json(parsed));

    await requestParse({
      req: new Request("https://attacker.example/api/contracts/x/upload", { method: "POST" }),
      storageKey: STORAGE_KEY,
      mimeType: "application/pdf",
      signal: new AbortController().signal,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://signloop-abc123.vercel.app/api/internal/parse");
    expect(new Headers(init.headers).get("x-vercel-protection-bypass")).toBe("bypass-value");
  });

  it("passes typed parse errors through", async () => {
    const limit = { ok: false, kind: "limit", message: "PDF has too many pages." };
    fetchMock.mockResolvedValue(Response.json(limit));

    expect(await call()).toEqual(limit);
  });

  it.each([
    ["a 404 (bad signature or a missing route)", () => new Response("Not Found", { status: 404 })],
    ["a redirect (Deployment Protection's login)", () => new Response(null, { status: 307, headers: { location: "https://vercel.com/sso" } })],
    ["a crashed function", () => new Response("FUNCTION_INVOCATION_FAILED", { status: 500 })],
    ["an answer of the wrong shape", () => Response.json({ ok: true, text: 42 })],
    ["invalid JSON", () => new Response("{", { status: 200 })],
  ])("reports %s as unavailable", async (_label, respond) => {
    fetchMock.mockResolvedValue(respond());

    expect(await call()).toEqual(UNAVAILABLE);
    expect(consoleError).toHaveBeenCalled();
  });

  it("reports a network failure as unavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    expect(await call()).toEqual(UNAVAILABLE);
    expect(consoleError).toHaveBeenCalledWith("Parse function call failed:", expect.any(TypeError));
  });

  it("does not log a call the upload canceled", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    expect(await call(controller.signal)).toEqual(UNAVAILABLE);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reports a missing signing secret as unavailable without calling out", async () => {
    vi.stubEnv("WORKOS_COOKIE_PASSWORD", "");

    expect(await call()).toEqual(UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
