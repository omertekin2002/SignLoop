export type WebSearchSource = {
  title: string;
  url: string;
  snippet: string | null;
};

export type WebSearchEvidence = {
  source: WebSearchSource;
  publishedAt: string | null;
  evidenceSnippet: string | null;
  trustScore: number;
  recencyScore: number;
  factScore: number;
  relevanceScore: number;
  totalScore: number;
};

export type WebSearchRun = {
  query: string;
  attemptedQueries: string[];
  successfulSearches: number;
  sources: WebSearchSource[];
};

const WEB_SEARCH_ENDPOINT = "https://r.jina.ai/http://duckduckgo.com/html/?q=";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_PAGE_FETCH_TIMEOUT_MS = 9000;
const DEFAULT_MAX_SOURCES_TO_FETCH = 3;
const PAGE_FETCH_PROXY_PREFIX = "https://r.jina.ai/http://";
const PAGE_FETCH_MAX_CHARS = 18000;
const MAX_QUERY_LENGTH = 220;
const MAX_SNIPPET_LENGTH = 320;

const QUERY_TOKEN_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "from",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "be",
  "to",
  "of",
  "in",
  "on",
  "at",
  "a",
  "an",
  "as",
  "it",
  "by",
  "or",
  "if",
  "today",
  "latest",
  "current",
  "news",
  "update",
  "updates",
]);

const TRUSTED_DOMAIN_SCORES: Array<{ suffix: string; score: number }> = [
  { suffix: "reuters.com", score: 4 },
  { suffix: "apnews.com", score: 4 },
  { suffix: "wsj.com", score: 4 },
  { suffix: "ft.com", score: 4 },
  { suffix: "bloomberg.com", score: 4 },
  { suffix: "spglobal.com", score: 4 },
  { suffix: "fred.stlouisfed.org", score: 4 },
  { suffix: "sec.gov", score: 4 },
  { suffix: "marketwatch.com", score: 3 },
  { suffix: "cnbc.com", score: 3 },
  { suffix: "finance.yahoo.com", score: 3 },
  { suffix: "google.com", score: 3 },
  { suffix: "stooq.com", score: 3 },
  { suffix: "nytimes.com", score: 2 },
  { suffix: "bbc.com", score: 2 },
];

const WEB_SEARCH_TRIGGER_PATTERN =
  /\b(web_search|search the web|browse the web|look up|lookup|latest|current|today|yesterday|this week|this month|breaking|real[-\s]?time|recent news|latest news|as of)\b/i;

const BROAD_NEWS_QUERY_PATTERN =
  /\b(latest news|breaking news|top news|headlines?|news today|current news|what(?:'s| is) (?:the )?latest news)\b/i;

function stripMarkdownDecorators(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractReadableTextFromLine(line: string): string {
  const markdownLinkMatch = line.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i);
  if (markdownLinkMatch) {
    return normalizeWhitespace(stripMarkdownDecorators(markdownLinkMatch[1] ?? ""));
  }

  return normalizeWhitespace(stripMarkdownDecorators(line));
}

function decodeDuckDuckGoRedirect(url: string): string | null {
  try {
    const parsed = new URL(url);
    const encoded = parsed.searchParams.get("uddg");
    if (!encoded) return null;
    const decoded = decodeURIComponent(encoded).trim();
    if (!/^https?:\/\//i.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function extractQueryTokens(query: string): string[] {
  return normalizeWhitespace(query)
    .toLowerCase()
    .split(/[^a-z0-9^.%]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !QUERY_TOKEN_STOP_WORDS.has(token));
}

function countQueryTokenMatches(tokens: readonly string[], text: string): number {
  if (!tokens.length || !text) return 0;
  const haystack = text.toLowerCase();
  let matches = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      matches += 1;
    }
  }

  return matches;
}

function resolveTrustedDomainScore(url: string): number {
  const parsed = safeParseUrl(url);
  if (!parsed) return 0;
  const hostname = parsed.hostname.toLowerCase();

  for (const entry of TRUSTED_DOMAIN_SCORES) {
    if (hostname === entry.suffix || hostname.endsWith(`.${entry.suffix}`)) {
      return entry.score;
    }
  }

  return 0;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseIsoDateCandidate(year: string, month: string, day: string): Date | null {
  const y = Number.parseInt(year, 10);
  const m = Number.parseInt(month, 10);
  const d = Number.parseInt(day, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }

  const candidate = new Date(Date.UTC(y, m - 1, d));
  if (
    candidate.getUTCFullYear() !== y ||
    candidate.getUTCMonth() !== m - 1 ||
    candidate.getUTCDate() !== d
  ) {
    return null;
  }

  return candidate;
}

function parseMonthNameDateCandidate(monthName: string, day: string, year: string): Date | null {
  const monthMap: Record<string, number> = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };

  const month = monthMap[monthName.toLowerCase()];
  if (!month) return null;
  return parseIsoDateCandidate(year, String(month), day);
}

function extractDateCandidates(text: string): Date[] {
  if (!text) return [];
  const candidates: Date[] = [];

  const isoDateRegex = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
  const slashDateRegex = /\b(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\b/g;
  const monthNameRegex =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-3]?\d),\s*(20\d{2})\b/gi;

  for (const match of text.matchAll(isoDateRegex)) {
    const parsed = parseIsoDateCandidate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
    if (parsed) candidates.push(parsed);
  }

  for (const match of text.matchAll(slashDateRegex)) {
    const parsed = parseIsoDateCandidate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
    if (parsed) candidates.push(parsed);
  }

  for (const match of text.matchAll(monthNameRegex)) {
    const parsed = parseMonthNameDateCandidate(match[1] ?? "", match[2] ?? "", match[3] ?? "");
    if (parsed) candidates.push(parsed);
  }

  return candidates;
}

function resolvePublishedAtIsoDate(source: WebSearchSource, pageMarkdown: string | null): string | null {
  const parsedUrl = safeParseUrl(source.url);
  const textWindow = [source.title, source.snippet ?? "", pageMarkdown ?? "", parsedUrl?.pathname ?? ""]
    .join("\n")
    .slice(0, PAGE_FETCH_MAX_CHARS);

  const candidates = extractDateCandidates(textWindow);
  if (!candidates.length) {
    return null;
  }

  const now = Date.now();
  const futureToleranceMs = 24 * 60 * 60 * 1000;
  const validCandidates = candidates.filter((candidate) => candidate.getTime() <= now + futureToleranceMs);
  if (!validCandidates.length) {
    return null;
  }

  const mostRecent = validCandidates.reduce((latest, current) =>
    current.getTime() > latest.getTime() ? current : latest
  );
  return toIsoDate(mostRecent);
}

function resolveRecencyScore(isoDate: string | null): number {
  if (!isoDate) return 0;

  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return 0;

  const dayDelta = Math.floor((Date.now() - parsed.getTime()) / (24 * 60 * 60 * 1000));
  if (dayDelta <= 2) return 4;
  if (dayDelta <= 7) return 3;
  if (dayDelta <= 30) return 1;
  if (dayDelta <= 180) return 0;
  return -1;
}

function resolveEvidenceSnippet(
  queryTokens: readonly string[],
  source: WebSearchSource,
  pageMarkdown: string | null
): string | null {
  const fallback = source.snippet;
  if (!pageMarkdown) {
    return fallback;
  }

  const lines = pageMarkdown
    .split("\n")
    .map((line) => normalizeWhitespace(stripMarkdownDecorators(line)))
    .filter((line) => line.length >= 40 && !/^https?:\/\//i.test(line))
    .slice(0, 140);

  let bestLine: string | null = null;
  let bestScore = -Infinity;

  for (const line of lines) {
    const relevance = countQueryTokenMatches(queryTokens, line);
    const hasNumber = /\b\d[\d,.%-]*\b/.test(line);
    const hasDate = /\b(20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      line
    );

    const score = relevance * 2 + (hasNumber ? 2 : 0) + (hasDate ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }

  if (!bestLine) {
    return fallback;
  }

  return bestLine.slice(0, MAX_SNIPPET_LENGTH);
}

async function fetchWebPageMarkdown(url: string, timeoutMs: number): Promise<string | null> {
  const parsedUrl = safeParseUrl(url);
  if (!parsedUrl) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${PAGE_FETCH_PROXY_PREFIX}${parsedUrl.toString()}`, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const body = await response.text();
    return body.slice(0, PAGE_FETCH_MAX_CHARS);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractSnippet(lines: readonly string[], startIdx: number, title: string): string | null {
  for (let idx = startIdx; idx < Math.min(lines.length, startIdx + 8); idx += 1) {
    const line = lines[idx]?.trim() ?? "";
    if (!line) continue;
    if (/^-{3,}$/.test(line)) continue;

    const text = extractReadableTextFromLine(line);
    if (!text) continue;
    if (text === title) continue;
    if (/^https?:\/\//i.test(text)) continue;
    if (text.length < 30) continue;

    return text.slice(0, MAX_SNIPPET_LENGTH);
  }

  return null;
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLikelyHomepagePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    return true;
  }

  const segment = path.replace(/^\//, "");
  return /^(home|index(?:\.html?)?|news|world|us|latest|top-stories)$/i.test(segment);
}

function sourceQualityScore(source: WebSearchSource): number {
  const parsedUrl = safeParseUrl(source.url);
  if (!parsedUrl) {
    return -5;
  }

  const title = source.title.toLowerCase();
  const snippet = (source.snippet ?? "").toLowerCase();
  const pathname = parsedUrl.pathname;
  const segments = pathname.split("/").filter(Boolean);

  let score = 0;

  if (isLikelyHomepagePath(pathname)) {
    score -= 4;
  }

  if (segments.length >= 2) {
    score += 2;
  }

  if (segments.length >= 3) {
    score += 1;
  }

  if (/\/\d{4}\/\d{2}\/\d{2}\//.test(pathname)) {
    score += 3;
  }

  if (/[-_][a-z0-9]{6,}/i.test(pathname)) {
    score += 1;
  }

  if (snippet.length >= 90) {
    score += 1;
  }

  if (/(breaking news|latest news|top stories)/i.test(title) && isLikelyHomepagePath(pathname)) {
    score -= 2;
  }

  if (/(live updates?|analysis|explainer|report|interview)/i.test(title)) {
    score += 1;
  }

  return score;
}

function dedupeQueries(queries: readonly string[]): string[] {
  const normalized = new Set<string>();
  const output: string[] = [];

  for (const query of queries) {
    const candidate = normalizeWhitespace(query).slice(0, MAX_QUERY_LENGTH);
    if (!candidate) continue;

    const key = candidate.toLowerCase();
    if (normalized.has(key)) continue;

    normalized.add(key);
    output.push(candidate);
  }

  return output;
}

function buildRetryQueries(baseQuery: string): string[] {
  const broadNewsQuery = BROAD_NEWS_QUERY_PATTERN.test(baseQuery);

  if (broadNewsQuery) {
    return dedupeQueries([
      baseQuery,
      `${baseQuery} top headlines today`,
      `${baseQuery} world`,
      `${baseQuery} US`,
      "world news top headlines today",
      "US breaking news today",
      "international news live updates",
      "breaking world news today Reuters AP",
      "site:reuters.com world news today",
      "site:apnews.com latest world news",
      "site:bbc.com/news latest headlines",
      "site:nytimes.com latest news",
    ]);
  }

  return dedupeQueries([
    baseQuery,
    `${baseQuery} latest updates`,
    `${baseQuery} today`,
    `${baseQuery} breaking`,
    `${baseQuery} analysis`,
    `${baseQuery} report`,
    `site:reuters.com ${baseQuery}`,
    `site:apnews.com ${baseQuery}`,
  ]);
}

function rankSources(sources: readonly WebSearchSource[]): WebSearchSource[] {
  return [...sources].sort((a, b) => {
    const scoreDelta = sourceQualityScore(b) - sourceQualityScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return b.title.length - a.title.length;
  });
}

export function shouldUseWebSearchForPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  return WEB_SEARCH_TRIGGER_PATTERN.test(trimmed);
}

export function buildWebSearchQuery(prompt: string): string {
  const trimmed = prompt.trim();
  const query = normalizeWhitespace(
    trimmed
      .replace(/^please\s+/i, "")
      .replace(/^can you\s+/i, "")
      .replace(/^could you\s+/i, "")
      .replace(/\buse the web_search tool\b/gi, "")
      .replace(/\bsearch the web\b/gi, "")
      .replace(/\blook up\b/gi, "")
  );

  if (!query) return trimmed.slice(0, MAX_QUERY_LENGTH);
  return query.slice(0, MAX_QUERY_LENGTH);
}

export function parseDuckDuckGoMarkdown(markdown: string, maxResults = DEFAULT_MAX_RESULTS): WebSearchSource[] {
  const lines = markdown.split("\n");
  const results: WebSearchSource[] = [];
  const seenUrls = new Set<string>();

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]?.trim() ?? "";
    if (!line) continue;

    const linkMatch = line.match(/^\[([^\]]+)\]\((https?:\/\/duckduckgo\.com\/l\/\?[^)]+)\)$/i);
    if (!linkMatch) continue;

    const rawTitle = normalizeWhitespace(stripMarkdownDecorators(linkMatch[1] ?? ""));
    if (!rawTitle || /^image\s+\d+$/i.test(rawTitle)) continue;

    const url = decodeDuckDuckGoRedirect(linkMatch[2] ?? "");
    if (!url || seenUrls.has(url)) continue;

    const snippet = extractSnippet(lines, idx + 1, rawTitle);

    results.push({
      title: rawTitle,
      url,
      snippet,
    });
    seenUrls.add(url);

    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

export async function searchWeb(query: string, options?: { maxResults?: number; timeoutMs?: number }): Promise<WebSearchSource[]> {
  const normalizedQuery = normalizeWhitespace(query).slice(0, MAX_QUERY_LENGTH);
  if (!normalizedQuery) {
    return [];
  }

  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // r.jina.ai decodes the forwarded URL once, so we double-encode query components.
    // Without this, queries containing "&" (e.g. "S&P 500") degrade to just "S".
    const encodedQueryForProxy = encodeURIComponent(normalizedQuery).replace(/%/g, "%25");
    const url = `${WEB_SEARCH_ENDPOINT}${encodedQueryForProxy}`;
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Web search request failed with status ${response.status}`);
    }

    const body = await response.text();
    return parseDuckDuckGoMarkdown(body, maxResults);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Web search failed:", { query: normalizedQuery, error: message });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichAndRankSources(
  query: string,
  sources: readonly WebSearchSource[],
  options?: { maxSourcesToFetch?: number; timeoutMs?: number }
): Promise<WebSearchEvidence[]> {
  if (!sources.length) {
    return [];
  }

  const maxSourcesToFetch = Math.max(0, options?.maxSourcesToFetch ?? DEFAULT_MAX_SOURCES_TO_FETCH);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PAGE_FETCH_TIMEOUT_MS;
  const queryTokens = extractQueryTokens(query);

  const sourcesToFetch = [...sources].slice(0, maxSourcesToFetch);
  const fetchedMarkdownByUrl = new Map<string, string | null>();

  const pageFetches = sourcesToFetch.map(async (source) => {
    const markdown = await fetchWebPageMarkdown(source.url, timeoutMs);
    fetchedMarkdownByUrl.set(source.url, markdown);
  });
  await Promise.allSettled(pageFetches);

  const evidenceRows: WebSearchEvidence[] = sources.map((source) => {
    const pageMarkdown = fetchedMarkdownByUrl.get(source.url) ?? null;
    const publishedAt = resolvePublishedAtIsoDate(source, pageMarkdown);
    const evidenceSnippet = resolveEvidenceSnippet(queryTokens, source, pageMarkdown);
    const trustScore = resolveTrustedDomainScore(source.url);
    const recencyScore = resolveRecencyScore(publishedAt);
    const factScore =
      evidenceSnippet && /\b\d[\d,.%-]*\b/.test(evidenceSnippet)
        ? 2
        : source.snippet && /\b\d[\d,.%-]*\b/.test(source.snippet)
          ? 1
          : 0;
    const relevanceScore = Math.min(
      4,
      countQueryTokenMatches(
        queryTokens,
        [source.title, source.snippet ?? "", evidenceSnippet ?? ""].join(" ")
      )
    );
    const totalScore =
      sourceQualityScore(source) + trustScore + recencyScore + factScore + relevanceScore;

    return {
      source,
      publishedAt,
      evidenceSnippet,
      trustScore,
      recencyScore,
      factScore,
      relevanceScore,
      totalScore,
    };
  });

  return evidenceRows.sort((left, right) => {
    const scoreDelta = right.totalScore - left.totalScore;
    if (scoreDelta !== 0) return scoreDelta;

    const recencyDelta = right.recencyScore - left.recencyScore;
    if (recencyDelta !== 0) return recencyDelta;

    return right.trustScore - left.trustScore;
  });
}

export async function searchWebWithRetries(
  promptOrQuery: string,
  options?: {
    maxResults?: number;
    timeoutMs?: number;
    maxAttempts?: number;
    targetHighQualityResults?: number;
  }
): Promise<WebSearchRun> {
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const targetHighQualityResults =
    options?.targetHighQualityResults ?? Math.max(3, Math.ceil(maxResults * 0.6));

  const query = buildWebSearchQuery(promptOrQuery);
  if (!query) {
    return { query, attemptedQueries: [], successfulSearches: 0, sources: [] };
  }

  const candidateQueries = buildRetryQueries(query);
  const limitedQueries = candidateQueries.slice(0, Math.max(1, maxAttempts));
  const attemptedQueries: string[] = [];
  let successfulSearches = 0;
  let staleRounds = 0;
  let previousHighQualityCount = 0;

  const uniqueSources = new Map<string, { source: WebSearchSource; score: number }>();

  for (const candidateQuery of limitedQueries) {
    attemptedQueries.push(candidateQuery);
    const beforeCount = uniqueSources.size;

    const batch = await searchWeb(candidateQuery, {
      maxResults: Math.max(maxResults * 2, 8),
      timeoutMs: options?.timeoutMs,
    });

    if (batch.length > 0) {
      successfulSearches += 1;
    }

    for (const source of batch) {
      const score = sourceQualityScore(source);
      const existing = uniqueSources.get(source.url);
      if (!existing || score > existing.score) {
        uniqueSources.set(source.url, { source, score });
      }
    }

    const ranked = rankSources([...uniqueSources.values()].map((entry) => entry.source));
    const highQuality = ranked.filter((source) => sourceQualityScore(source) >= 1);
    const highQualityGain = highQuality.length - previousHighQualityCount;
    previousHighQualityCount = highQuality.length;
    const newUniqueSources = uniqueSources.size - beforeCount;
    const hasNoMeaningfulProgress = newUniqueSources <= 0 && highQualityGain <= 0;
    staleRounds = hasNoMeaningfulProgress ? staleRounds + 1 : 0;

    if (highQuality.length >= targetHighQualityResults && staleRounds >= 1) {
      break;
    }

    if (highQuality.length < targetHighQualityResults && staleRounds >= 3) {
      break;
    }
  }

  const rankedAll = rankSources([...uniqueSources.values()].map((entry) => entry.source));
  const highQuality = rankedAll.filter((source) => sourceQualityScore(source) >= 1);

  const finalSources =
    highQuality.length >= Math.min(2, maxResults)
      ? highQuality.slice(0, maxResults)
      : rankedAll.slice(0, maxResults);

  return {
    query,
    attemptedQueries,
    successfulSearches,
    sources: finalSources,
  };
}

export function buildWebSearchContext(
  query: string,
  sources: readonly WebSearchSource[],
  attemptedQueries: readonly string[] = [],
  successfulSearches = 0
): string {
  const lines: string[] = [
    "External web search context (provided by the application):",
    `Primary query: ${query}`,
    `Retrieved at: ${new Date().toISOString()}`,
    "Use these sources for time-sensitive facts.",
    "Prefer article-level URLs over generic homepages when citing.",
    "Do not say you lack web access when this context is present.",
    "If you use this context, cite URLs in your answer.",
  ];

  if (attemptedQueries.length > 0) {
    lines.push(`Search attempts (${attemptedQueries.length}):`);
    for (const [index, attemptedQuery] of attemptedQueries.entries()) {
      lines.push(`${index + 1}. ${attemptedQuery}`);
    }
  }
  if (successfulSearches > 0) {
    lines.push(`Successful searches: ${successfulSearches}`);
  }

  lines.push("", "Sources:");

  for (const [index, source] of sources.entries()) {
    lines.push(`${index + 1}. ${source.title}`);
    lines.push(`URL: ${source.url}`);
    if (source.snippet) {
      lines.push(`Snippet: ${source.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
