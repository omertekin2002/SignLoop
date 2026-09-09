import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/gemini-search", () => ({ searchWeb: vi.fn() }));
import { searchWeb as geminiGroundedSearch } from "@/lib/gemini-search";
import {
  MAX_WEB_SEARCH_RESULTS,
  resolveWebSearchProvider,
  searchWeb,
} from "./web-search";

const KEYS = [
  "WEB_SEARCH_PROVIDER",
  "BRAVE_SEARCH_API_KEY",
  "FIRECRAWL_API_KEY",
  "GEMINI_API_KEY",
];

function configure(values: Record<string, string>) {
  for (const key of KEYS) vi.stubEnv(key, values[key] ?? "");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(geminiGroundedSearch).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveWebSearchProvider", () => {
  it("prefers Brave over a Firecrawl key that may only exist for read_url", () => {
    configure({ BRAVE_SEARCH_API_KEY: "b", FIRECRAWL_API_KEY: "f", GEMINI_API_KEY: "g" });
    expect(resolveWebSearchProvider()).toBe("brave");
  });

  it("falls back through Firecrawl to Gemini, then to nothing", () => {
    configure({ FIRECRAWL_API_KEY: "f", GEMINI_API_KEY: "g" });
    expect(resolveWebSearchProvider()).toBe("firecrawl");
    configure({ GEMINI_API_KEY: "g" });
    expect(resolveWebSearchProvider()).toBe("gemini");
    configure({});
    expect(resolveWebSearchProvider()).toBeNull();
  });

  it("honors an explicit override even when another key is present", () => {
    configure({ WEB_SEARCH_PROVIDER: "gemini", BRAVE_SEARCH_API_KEY: "b" });
    expect(resolveWebSearchProvider()).toBe("gemini");
  });
});

describe("searchWeb", () => {
  it("returns Brave results as leads with no brief", async () => {
    configure({ BRAVE_SEARCH_API_KEY: "brave-key" });
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        web: {
          results: [
            { title: "  ISCTR  quote ", url: "https://a.test/x", description: "Closed at 13.38" },
            { title: "Second", url: "https://b.test/y", description: "" },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("ISCTR close");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("api.search.brave.com/res/v1/web/search");
    expect(String(url)).toContain("q=ISCTR+close");
    expect(init?.headers).toMatchObject({ "X-Subscription-Token": "brave-key" });
    expect(result).toEqual({
      provider: "brave",
      query: "ISCTR close",
      brief: null,
      results: [
        { title: "ISCTR quote", url: "https://a.test/x", snippet: "Closed at 13.38" },
        { title: "Second", url: "https://b.test/y", snippet: null },
      ],
    });
  });

  it("asks Firecrawl for web results only, so search stays a lead list", async () => {
    configure({ FIRECRAWL_API_KEY: "fc-key" });
    const fetchMock = vi.fn().mockResolvedValue(
      json({ success: true, data: { web: [{ title: "T", url: "https://c.test/", description: "D" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("contract law");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.firecrawl.dev/v2/search");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer fc-key" });
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "contract law",
      limit: MAX_WEB_SEARCH_RESULTS,
      sources: ["web"],
    });
    expect(JSON.parse(init?.body as string)).not.toHaveProperty("scrapeOptions");
    expect(result.provider).toBe("firecrawl");
    expect(result.results).toEqual([{ title: "T", url: "https://c.test/", snippet: "D" }]);
  });

  it("drops duplicates and non-http entries, and caps the result count", async () => {
    configure({ BRAVE_SEARCH_API_KEY: "b" });
    const results = [
      { title: "dupe", url: "https://a.test/x", description: "one" },
      { title: "dupe again", url: "https://a.test/x", description: "two" },
      { title: "bad scheme", url: "ftp://a.test/z", description: "no" },
      { title: "no url" },
      ...Array.from({ length: 12 }, (_, index) => ({
        title: `r${index}`,
        url: `https://d.test/${index}`,
        description: "x",
      })),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ web: { results } })));
    const result = await searchWeb("q");
    expect(result.results).toHaveLength(MAX_WEB_SEARCH_RESULTS);
    expect(result.results.filter((entry) => entry.url === "https://a.test/x")).toHaveLength(1);
    expect(result.results.some((entry) => entry.url.startsWith("ftp:"))).toBe(false);
  });

  it("reports an empty result set rather than inventing one", async () => {
    configure({ BRAVE_SEARCH_API_KEY: "b" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ web: { results: [] } })));
    await expect(searchWeb("nothing")).rejects.toMatchObject({
      name: "WebSearchError",
      publicMessage: expect.stringMatching(/returned no results/),
    });
  });

  it("wraps provider failures in a public-safe error", async () => {
    configure({ BRAVE_SEARCH_API_KEY: "b" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "rate limited" }, 429)));
    await expect(searchWeb("q")).rejects.toMatchObject({
      name: "WebSearchError",
      publicMessage: expect.stringMatching(/Web search failed/),
    });
  });

  it("explains when no provider is configured, without calling out", async () => {
    configure({});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchWeb("q")).rejects.toMatchObject({
      name: "WebSearchError",
      publicMessage: expect.stringMatching(/BRAVE_SEARCH_API_KEY/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the Gemini grounding brief when it is the configured fallback", async () => {
    configure({ GEMINI_API_KEY: "g" });
    vi.mocked(geminiGroundedSearch).mockResolvedValue({
      brief: "A grounded brief.",
      metadata: {
        query: "isctr",
        attemptedQueries: ["isctr"],
        successfulSearches: 1,
        sources: [{ title: "S", url: "https://e.test/", snippet: null }],
      },
    });
    const result = await searchWeb("isctr");
    expect(result).toEqual({
      provider: "gemini",
      query: "isctr",
      brief: "A grounded brief.",
      results: [{ title: "S", url: "https://e.test/", snippet: null }],
    });
  });
});
