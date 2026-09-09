import { afterEach, expect, it, vi } from "vitest";
import { MAX_PAGE_CHARACTERS, readUrl } from "./url-reader";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

it("rejects addresses that are not public http(s) pages without fetching", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  for (const url of [
    "ftp://files.test/a",
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://user:pw@site.test/",
    "http://intranet/",
    "not a url",
  ]) {
    await expect(readUrl(url)).rejects.toMatchObject({
      name: "UrlReadError",
      publicMessage: expect.stringMatching(/http\(s\) web addresses/),
    });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it("uses Jina Reader when Firecrawl is not configured and truncates long pages", async () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  vi.stubEnv("JINA_API_KEY", "");
  const fetchMock = vi.fn().mockResolvedValue(
    json({
      code: 200,
      data: {
        title: "  Long   page ",
        url: "https://site.test/a",
        content: "x".repeat(MAX_PAGE_CHARACTERS + 500),
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await readUrl("https://site.test/a");
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://r.jina.ai/https://site.test/a");
  expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  expect(result).toMatchObject({ provider: "jina", title: "Long page", truncated: true });
  expect(result.content).toHaveLength(MAX_PAGE_CHARACTERS);
});

it("prefers Firecrawl when configured and falls back to Jina when it fails", async () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ success: false, error: "rate limited" }, 429))
    .mockResolvedValueOnce(
      json({ code: 200, data: { title: "Fallback", url: "https://site.test/b", content: "Body" } }),
    );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await readUrl("https://site.test/b");
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.firecrawl.dev/v2/scrape");
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    url: "https://site.test/b",
    formats: ["markdown"],
    parsers: ["pdf"],
  });
  expect(result).toMatchObject({ provider: "jina", title: "Fallback", content: "Body" });
});

it("returns Firecrawl markdown when the scrape succeeds", async () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
  const fetchMock = vi.fn().mockResolvedValue(
    json({
      success: true,
      data: { markdown: "# Statute\n\nText", metadata: { title: "Statute", sourceURL: "https://law.test/s" } },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await readUrl("https://law.test/s");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(result).toEqual({
    provider: "firecrawl",
    title: "Statute",
    url: "https://law.test/s",
    content: "# Statute\n\nText",
    truncated: false,
  });
});

it("wraps reader failures in a public-safe error", async () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: 500 }, 500)));
  await expect(readUrl("https://site.test/down")).rejects.toMatchObject({
    name: "UrlReadError",
    publicMessage: expect.stringMatching(/could not be read/),
  });
});
