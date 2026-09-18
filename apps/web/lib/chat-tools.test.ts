import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/url-reader", () => ({ readUrl: vi.fn() }));
vi.mock("@/lib/server-db", () => ({ listContractsForChat: vi.fn(), getContractTextForUser: vi.fn() }));
vi.mock("@/lib/image-generation", () => ({ generateImageReply: vi.fn() }));
vi.mock("@/lib/http-fetch", () => ({ httpGet: vi.fn() }));
import { httpGet } from "@/lib/http-fetch";
import { readUrl } from "@/lib/url-reader";
import { getContractTextForUser, listContractsForChat } from "@/lib/server-db";
import {
  CONTRACT_WINDOW_CHARACTERS,
  createHttpGetTool,
  createUrlReaderTool,
  createContractTools,
  excerptContract,
  fenceUntrusted,
  MAX_HTTP_FETCHES,
} from "./chat-tools";

describe("excerptContract", () => {
  const text = `${"a".repeat(CONTRACT_WINDOW_CHARACTERS)}Clause 9. Indemnification survives termination. ${"b".repeat(700)}Clause 12. Indemnification cap applies.`;

  it("returns sequential windows with a continuation offset", () => {
    const first = excerptContract(text);
    expect(first).toMatchObject({ offset: 0, nextOffset: CONTRACT_WINDOW_CHARACTERS });
    expect(first.content).toHaveLength(CONTRACT_WINDOW_CHARACTERS);
    const rest = excerptContract(text, { offset: first.nextOffset! });
    expect(rest.content.startsWith("Clause 9.")).toBe(true);
    expect(rest.nextOffset).toBeNull();
    expect(excerptContract(text, { offset: 10_000_000 })).toMatchObject({ content: "", nextOffset: null });
  });

  it("returns merged excerpts around keyword matches", () => {
    const result = excerptContract(text, { find: "indemnification termination" });
    expect(result.matchCount).toBe(3);
    expect(result.content).toContain("Clause 9. Indemnification survives termination.");
    expect(result.content).toContain("Clause 12. Indemnification cap applies.");
    expect(result.content.split("[...]")).toHaveLength(2);
    expect(result.content.length).toBeLessThan(2_000);
    expect(result.nextOffset).toBeNull();
    expect(result.truncated).toBeUndefined();
    expect(excerptContract(text, { find: "arbitration" })).toMatchObject({ matchCount: 0, content: "" });
  });

  it("bounds a large merged excerpt and resumes without skipping document text", () => {
    const document = Array.from({ length: 40 }, () => "indemnification " + "x".repeat(480)).join("\n");
    const first = excerptContract(document, { find: "indemnification" });

    expect(first.content.length).toBeLessThanOrEqual(CONTRACT_WINDOW_CHARACTERS);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).not.toBeNull();
    const rest = excerptContract(document, { offset: first.nextOffset! });
    expect(first.content.replace(/^@0: /, "") + rest.content).toBe(document);
  });

  it("shares the character budget across separate merged excerpts and their labels", () => {
    const block = (term: string) => Array.from({ length: 20 }, () => term + "x".repeat(480)).join("\n");
    const document = block("alpha ") + "z".repeat(1_000) + block("beta ");
    const result = excerptContract(document, { find: "alpha beta" });

    expect(result.content).toContain("\n[...]\n@");
    expect(result.content).toContain("beta");
    expect(result.content.length).toBeLessThanOrEqual(CONTRACT_WINDOW_CHARACTERS);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBeGreaterThan(document.indexOf("beta"));
    expect(excerptContract(document, { offset: result.nextOffset! }).content)
      .toBe(document.slice(result.nextOffset!, result.nextOffset! + CONTRACT_WINDOW_CHARACTERS));
  });

  it("provides continuation when the excerpt-count limit omits another match", () => {
    const document = Array.from({ length: 9 }, () => "indemnification " + "x".repeat(1_000)).join("\n");
    const result = excerptContract(document, { find: "indemnification" });

    expect(result.content.split("\n[...]\n")).toHaveLength(8);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(document.lastIndexOf("indemnification") - 300);
    expect(excerptContract(document, { offset: result.nextOffset! }).content).toContain("indemnification");
  });
});

it("exposes truncated keyword results and continuation through read_contract", async () => {
  const contractId = "11111111-1111-4111-8111-111111111111";
  vi.mocked(getContractTextForUser).mockResolvedValueOnce({
    id: contractId,
    title: "Long contract",
    status: "DRAFT",
    extractionWarning: null,
    text: Array.from({ length: 40 }, () => "indemnification " + "x".repeat(480)).join("\n"),
  });
  const tools = createContractTools({ userId: "owner", signal: new AbortController().signal });
  const result = await tools.read_contract!.execute!(
    { contractId, find: "indemnification" },
    { toolCallId: "read", messages: [], context: undefined },
  );

  expect(result).toMatchObject({ truncated: true, nextOffset: expect.any(Number) });
  expect(getContractTextForUser).toHaveBeenLastCalledWith("owner", contractId);
});

describe.each(["http_get", "read_url"] as const)("%s URL cache", (name) => {
  beforeEach(() => {
    vi.mocked(httpGet).mockReset();
    vi.mocked(readUrl).mockReset();
    vi.mocked(httpGet).mockImplementation(async (url) => ({ url, body: url, status: 200, contentType: null, truncated: false }));
    vi.mocked(readUrl).mockImplementation(async (url) => ({ url, content: url, title: url, provider: "jina", truncated: false }));
  });

  it.each([
    ["https://site.test/ABC", "https://site.test/abc"],
    ["https://site.test/item?key=ABC", "https://site.test/item?key=abc"],
    ["https://site.test/item", "https://site.test/item/"],
  ])("fetches distinct addresses separately: %s and %s", async (firstUrl, secondUrl) => {
    const deps = { signal: new AbortController().signal, addSource: () => 1 };
    const tools = name === "http_get" ? createHttpGetTool(deps) : createUrlReaderTool(deps);
    const execute = tools[name]!.execute!;
    const first = await execute({ url: firstUrl }, { toolCallId: "a", messages: [], context: undefined });
    const second = await execute({ url: secondUrl }, { toolCallId: "b", messages: [], context: undefined });
    expect(name === "http_get" ? httpGet : readUrl).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ url: firstUrl });
    expect(second).toMatchObject({ url: secondUrl });
  });

  it("still deduplicates differences in hostname casing", async () => {
    const deps = { signal: new AbortController().signal, addSource: () => 1 };
    const tools = name === "http_get" ? createHttpGetTool(deps) : createUrlReaderTool(deps);
    const execute = tools[name]!.execute!;
    const first = await execute({ url: "https://SITE.test/ABC" }, { toolCallId: "a", messages: [], context: undefined });
    const second = await execute({ url: "https://site.test/ABC" }, { toolCallId: "b", messages: [], context: undefined });
    expect(second).toEqual(first);
    expect(name === "http_get" ? httpGet : readUrl).toHaveBeenCalledOnce();
  });
});

it("passes contract pagination and title search to the owner-scoped query", async () => {
  vi.mocked(listContractsForChat).mockResolvedValueOnce({ contracts: [], nextOffset: 50 })
    .mockResolvedValueOnce({ contracts: [], nextOffset: null });
  const tools = createContractTools({ userId: "owner", signal: new AbortController().signal });
  const execute = tools.list_contracts!.execute!;
  expect(await execute({ query: "NDA" }, { toolCallId: "a", messages: [], context: undefined }))
    .toMatchObject({ hasMore: true, nextOffset: 50 });
  expect(await execute({ query: "NDA", offset: 50 }, { toolCallId: "b", messages: [], context: undefined }))
    .toMatchObject({ hasMore: false, nextOffset: null });
  expect(listContractsForChat).toHaveBeenLastCalledWith("owner", { query: "NDA", offset: 50 });
});

it("fences untrusted content with explicit delimiters", () => {
  expect(fenceUntrusted("hello")).toMatch(/^<<<BEGIN UNTRUSTED CONTENT.*\nhello\n<<<END UNTRUSTED CONTENT>>>$/s);
});

describe("createHttpGetTool", () => {
  beforeEach(() => {
    vi.mocked(httpGet).mockReset();
  });

  type Executor = (input: { url: string }) => Promise<Record<string, unknown>>;

  function build() {
    const addSource = vi.fn().mockReturnValue(1);
    const tools = createHttpGetTool({ signal: new AbortController().signal, addSource });
    const execute = ((input: { url: string }) =>
      (tools.http_get!.execute as unknown as (
        i: { url: string },
        o: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>)(input, { toolCallId: "t", messages: [] })) as Executor;
    return { addSource, execute };
  }

  it("registers a citable source and fences the body", async () => {
    vi.mocked(httpGet).mockResolvedValue({
      url: "https://api.test/v1/quote?symbol=ISCTR",
      status: 200,
      contentType: "application/json",
      body: '{"close":13.38}',
      truncated: false,
    });
    const { addSource, execute } = build();
    const result = await execute({ url: "https://api.test/v1/quote?symbol=ISCTR" });
    expect(addSource).toHaveBeenCalledWith({
      title: "api.test/v1/quote",
      url: "https://api.test/v1/quote?symbol=ISCTR",
    });
    expect(result).toMatchObject({ number: 1, status: 200, truncated: false });
    expect(result.body).toBe(fenceUntrusted('{"close":13.38}'));
  });

  it("serves a repeated address from cache without refetching", async () => {
    vi.mocked(httpGet).mockResolvedValue({
      url: "https://api.test/a",
      status: 200,
      contentType: null,
      body: "{}",
      truncated: false,
    });
    const { execute } = build();
    await execute({ url: "https://api.test/a" });
    await execute({ url: "https://API.test/a" });
    expect(httpGet).toHaveBeenCalledOnce();
  });

  it("reports an exhausted budget instead of fetching further", async () => {
    vi.mocked(httpGet).mockImplementation(async (url: string) => ({
      url,
      status: 200,
      contentType: null,
      body: "{}",
      truncated: false,
    }));
    const { execute } = build();
    for (let index = 0; index < MAX_HTTP_FETCHES; index++) {
      await execute({ url: `https://api.test/${index}` });
    }
    expect(await execute({ url: "https://api.test/overflow" })).toMatchObject({
      error: expect.stringMatching(/budget exhausted/),
    });
    expect(httpGet).toHaveBeenCalledTimes(MAX_HTTP_FETCHES);
  });

  it("converts a blocked address into a public-safe tool error", async () => {
    vi.mocked(httpGet).mockRejectedValue(
      Object.assign(new Error("Blocked host: 169.254.169.254"), {
        publicMessage: "Only public http(s) web addresses can be read.",
      }),
    );
    const { execute } = build();
    expect(await execute({ url: "http://169.254.169.254/" })).toEqual({
      error: "Only public http(s) web addresses can be read.",
    });
  });
});
