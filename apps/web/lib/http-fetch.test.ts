import { afterEach, expect, it, vi } from "vitest";
import { httpGet, MAX_FETCH_RESPONSE_CHARACTERS } from "./http-fetch";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

it("rejects addresses that are not public http(s) endpoints without fetching", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  for (const url of [
    "ftp://files.test/a",
    "http://localhost:8317/v1/models",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://user:pw@site.test/",
    "http://intranet/",
    "not a url",
  ]) {
    await expect(httpGet(url)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/http\(s\) web addresses/),
    });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it("returns the raw body, status, and content type verbatim", async () => {
  const body = JSON.stringify({ symbol: "ISCTR", close: 13.38, currency: "TRY" });
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await httpGet("https://api.test/quote?symbol=ISCTR");
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
  expect(result).toEqual({
    url: "https://api.test/quote?symbol=ISCTR",
    status: 200,
    contentType: "application/json",
    body,
    truncated: false,
  });
});

it("returns non-2xx responses instead of throwing, so the model can adapt", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("no session data", { status: 404 })),
  );
  const result = await httpGet("https://api.test/quote?date=2026-09-08");
  expect(result).toMatchObject({ status: 404, body: "no session data" });
});

it("follows redirects and reports the address that actually answered", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(redirect("/v2/quote", 301))
    .mockResolvedValueOnce(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await httpGet("https://api.test/quote");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.test/v2/quote");
  expect(result.url).toBe("https://api.test/v2/quote");
});

it("re-validates every redirect hop, so a 302 cannot reach a private address", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(httpGet("https://api.test/quote")).rejects.toMatchObject({
    publicMessage: expect.stringMatching(/http\(s\) web addresses/),
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("stops after too many redirects", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirect("https://api.test/loop")));
  await expect(httpGet("https://api.test/start")).rejects.toMatchObject({
    name: "HttpFetchError",
    publicMessage: expect.stringMatching(/redirected too many times/),
  });
});

it("truncates oversized bodies", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("x".repeat(MAX_FETCH_RESPONSE_CHARACTERS + 500))),
  );
  const result = await httpGet("https://api.test/big");
  expect(result.truncated).toBe(true);
  expect(result.body).toHaveLength(MAX_FETCH_RESPONSE_CHARACTERS);
});

it("wraps transport failures in a public-safe error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 1.2.3.4:443")));
  await expect(httpGet("https://api.test/down")).rejects.toMatchObject({
    name: "HttpFetchError",
    publicMessage: expect.stringMatching(/could not be fetched/),
  });
});
