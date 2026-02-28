export type WebSearchSource = {
  title: string;
  url: string;
  snippet: string | null;
};

const WEB_SEARCH_ENDPOINT = "https://r.jina.ai/http://duckduckgo.com/html/?q=";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_QUERY_LENGTH = 220;
const MAX_SNIPPET_LENGTH = 320;

const WEB_SEARCH_TRIGGER_PATTERN =
  /\b(web_search|search the web|browse the web|look up|lookup|latest|current|today|yesterday|this week|this month|breaking|real[-\s]?time|recent news|latest news|as of)\b/i;

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
    const url = `${WEB_SEARCH_ENDPOINT}${encodeURIComponent(normalizedQuery)}`;
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

export function buildWebSearchContext(query: string, sources: readonly WebSearchSource[]): string {
  const lines: string[] = [
    "External web search context (provided by the application):",
    `Query: ${query}`,
    `Retrieved at: ${new Date().toISOString()}`,
    "Use these sources for time-sensitive facts.",
    "Do not say you lack web access when this context is present.",
    "If you use this context, cite URLs in your answer.",
    "",
    "Sources:",
  ];

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
