import OpenAI from 'openai';
import { isAllowedPrimaryModel } from '@/lib/model-settings';
import {
    buildWebSearchQuery,
    enrichAndRankSources,
    searchWeb,
    type WebSearchEvidence,
    type WebSearchSource,
} from '@/lib/web-search';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';
const OPENROUTER_BACKUP_MODEL = process.env.OPENROUTER_BACKUP_MODEL || 'openrouter/free';
const PRIMARY_LLM_BASE_URL =
    process.env.PRIMARY_LLM_BASE_URL || 'https://efficient-sightlessly-ouida.ngrok-free.dev/v1';
const PRIMARY_LLM_MODEL = process.env.PRIMARY_LLM_MODEL || 'gemini-3-flash';
const PRIMARY_LLM_API_KEY = process.env.PRIMARY_LLM_API_KEY;
const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const APP_NAME = 'SignLoop';

const MAX_MODEL_SEARCH_ROUNDS = 6;
const MAX_TOTAL_SEARCH_QUERIES = 18;
const MAX_SEARCH_QUERIES_PER_ROUND = 3;
const SEARCH_RESULTS_PER_QUERY = 8;
const MAX_WEB_SOURCES_IN_METADATA = 8;
const APP_LAYER_SEARCH_LOOP_DELAY_MS = 3000;
const MAX_RECENCY_VALIDATION_RETRIES = 1;
const NATIVE_WEB_SEARCH_MODELS = new Set(['gpt-5', 'gpt-5.1', 'gpt-5.2']);

const RECENCY_PROMPT_PATTERN = /\b(today|now|latest|current|currently|as of)\b/i;
const YEAR_PATTERN = /\b(19|20)\d{2}\b/g;

const MODEL_DRIVEN_WEB_SEARCH_PROMPT = `
You can use an application-level web search tool in this chat.

Return exactly one JSON object and nothing else on every response:
- To search the web: {"type":"web_search","queries":["query 1","query 2"],"reason":"short reason"}
- To query market data: {"type":"market_data","symbol":"^spx","date":"2026-02-27","reason":"short reason"}
- To answer the user: {"type":"final","answer":"your user-facing answer"}

Rules:
- Use web_search only when current, external, or uncertain facts need verification.
- Use market_data for index/market close requests (S&P 500, Dow, Nasdaq), especially for specific dates.
- For market_data dates, use ISO format YYYY-MM-DD. Optional range format: {"type":"market_data","symbol":"^spx","from":"2026-02-01","to":"2026-02-28","limit":5}
- If no web lookup is needed, return type=final immediately.
- For web_search, include 1-3 focused queries.
- After tool results are provided, decide whether more search is needed or return final.
- Refine queries when results are generic (homepages, low-detail snippets).
- In final answers based on web results, cite source URLs inline.
`.trim();

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
    role: ChatRole;
    content: string;
};

export type ChatReply = {
    message: string;
    provider: 'ngrok-openai-compatible' | 'openrouter';
    model: string;
    webSearch: {
        query: string;
        attemptedQueries: string[];
        successfulSearches: number;
        sources: WebSearchSource[];
    } | null;
};

type SearchPlannerAction =
    | { type: 'web_search'; queries: string[]; reason?: string }
    | {
          type: 'market_data';
          symbol: string;
          date?: string;
          from?: string;
          to?: string;
          limit?: number;
          reason?: string;
      }
    | { type: 'final'; answer: string };

type ModelDrivenSearchResult = {
    message: string;
    webSearch: ChatReply['webSearch'];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNativeWebSearchModel(model: string): boolean {
    return NATIVE_WEB_SEARCH_MODELS.has(model);
}

function isUnsupportedWebSearchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unsupported tool type:\s*web_search|web_search|tool_choice|invalid.*tools?|unknown tool/i.test(
        message
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function getLatestUserPrompt(messages: readonly ChatMessage[]): string {
    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
        const message = messages[idx];
        if (message?.role === 'user') {
            return message.content.trim();
        }
    }

    return '';
}

type MarketDataPoint = {
    date: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
};

type MarketSymbolResolution = {
    displayName: string;
    stooqSymbol: string;
};

type MarketDataResult = {
    symbol: MarketSymbolResolution;
    sourceUrl: string;
    points: MarketDataPoint[];
};

type MarketDataToolFeedback = {
    attemptLabel: string;
    message: string;
    success: boolean;
    sources: WebSearchSource[];
};

function isValidIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }

    return parsed.toISOString().slice(0, 10) === value;
}

function normalizeDateInput(value: string | undefined): string | null {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    return isValidIsoDate(trimmed) ? trimmed : null;
}

function toStooqDate(isoDate: string): string {
    return isoDate.replace(/-/g, '');
}

function parseStooqNumber(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed === 'N/D') {
        return null;
    }

    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseStooqQuoteLine(line: string): MarketDataPoint | null {
    const columns = line.split(',').map((value) => value.trim());
    if (columns.length < 8) {
        return null;
    }

    const rawDate = columns[1] ?? '';
    if (!/^\d{8}$/.test(rawDate)) {
        return null;
    }

    return {
        date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
        open: parseStooqNumber(columns[3]),
        high: parseStooqNumber(columns[4]),
        low: parseStooqNumber(columns[5]),
        close: parseStooqNumber(columns[6]),
        volume: parseStooqNumber(columns[7]),
    };
}

function parseStooqHistoricalCsv(csvText: string): MarketDataPoint[] {
    const lines = csvText
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length <= 1) {
        return [];
    }

    const rows: MarketDataPoint[] = [];
    for (const line of lines.slice(1)) {
        const columns = line.split(',').map((value) => value.trim());
        if (columns.length < 6) {
            continue;
        }

        const date = columns[0] ?? '';
        if (!isValidIsoDate(date)) {
            continue;
        }

        rows.push({
            date,
            open: parseStooqNumber(columns[1]),
            high: parseStooqNumber(columns[2]),
            low: parseStooqNumber(columns[3]),
            close: parseStooqNumber(columns[4]),
            volume: parseStooqNumber(columns[5]),
        });
    }

    return rows;
}

function normalizeMarketSymbol(symbol: string): MarketSymbolResolution | null {
    const raw = symbol.trim();
    if (!raw) {
        return null;
    }

    const normalized = raw.toLowerCase();
    const compact = normalized.replace(/[\s._-]+/g, '');

    if (
        compact === '^spx' ||
        compact === '^gspc' ||
        compact === 'spx' ||
        compact === 'sp500' ||
        compact === 's&p500' ||
        compact === 'sandp500' ||
        compact === 'snp500'
    ) {
        return { displayName: 'S&P 500', stooqSymbol: '^spx' };
    }

    if (
        compact === '^dji' ||
        compact === 'dji' ||
        compact === 'djia' ||
        compact === 'dowjones' ||
        compact === 'dowjonesindustrialaverage'
    ) {
        return { displayName: 'Dow Jones Industrial Average', stooqSymbol: '^dji' };
    }

    if (
        compact === '^ixic' ||
        compact === 'ixic' ||
        compact === 'nasdaq' ||
        compact === 'nasdaqcomposite'
    ) {
        return { displayName: 'NASDAQ Composite', stooqSymbol: '^ixic' };
    }

    if (!/^\^?[a-z0-9.-]{1,24}$/i.test(raw)) {
        return null;
    }

    return {
        displayName: raw.toUpperCase(),
        stooqSymbol: raw.toLowerCase(),
    };
}

function clampMarketLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit ?? NaN)) {
        return 5;
    }

    const rounded = Math.floor(limit ?? 5);
    return Math.min(20, Math.max(1, rounded));
}

async function fetchMarketDataFromStooq(args: {
    symbol: MarketSymbolResolution;
    date?: string;
    from?: string;
    to?: string;
    limit?: number;
}): Promise<MarketDataResult | null> {
    const limit = clampMarketLimit(args.limit);

    const date = normalizeDateInput(args.date);
    const from = normalizeDateInput(args.from);
    const to = normalizeDateInput(args.to);

    if (args.date && !date) {
        return null;
    }
    if (args.from && !from) {
        return null;
    }
    if (args.to && !to) {
        return null;
    }

    try {
        if (date || from || to) {
            const startCandidate = date ?? from ?? to ?? '';
            const endCandidate = date ?? to ?? from ?? '';
            const [rangeStart, rangeEnd] =
                startCandidate <= endCandidate
                    ? [startCandidate, endCandidate]
                    : [endCandidate, startCandidate];
            const sourceUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(args.symbol.stooqSymbol)}&i=d&d1=${toStooqDate(rangeStart)}&d2=${toStooqDate(rangeEnd)}`;
            const response = await fetch(sourceUrl, { method: 'GET' });
            if (!response.ok) {
                return null;
            }

            const csv = await response.text();
            const points = parseStooqHistoricalCsv(csv)
                .sort((left, right) => right.date.localeCompare(left.date))
                .slice(0, limit);

            return {
                symbol: args.symbol,
                sourceUrl,
                points,
            };
        }

        const sourceUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(args.symbol.stooqSymbol)}&i=d`;
        const response = await fetch(sourceUrl, { method: 'GET' });
        if (!response.ok) {
            return null;
        }

        const firstLine = (await response.text()).trim().split('\n')[0]?.trim() ?? '';
        if (!firstLine) {
            return null;
        }

        const point = parseStooqQuoteLine(firstLine);
        return {
            symbol: args.symbol,
            sourceUrl,
            points: point ? [point] : [],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn('Market data fetch failed:', {
            symbol: args.symbol.stooqSymbol,
            date: args.date,
            from: args.from,
            to: args.to,
            error: errorMessage,
        });
        return null;
    }
}

function formatMarketDataPoint(point: MarketDataPoint): string {
    const fmt = (value: number | null): string => (value === null ? 'N/A' : value.toFixed(2));
    const vol = point.volume === null ? 'N/A' : Math.round(point.volume).toString();
    return `date=${point.date} open=${fmt(point.open)} high=${fmt(point.high)} low=${fmt(point.low)} close=${fmt(point.close)} volume=${vol}`;
}

async function executeMarketDataTool(
    action: Extract<SearchPlannerAction, { type: 'market_data' }>
): Promise<MarketDataToolFeedback> {
    const attemptLabelParts = [`market_data ${action.symbol}`];
    if (action.date) {
        attemptLabelParts.push(`date=${action.date}`);
    } else {
        if (action.from) attemptLabelParts.push(`from=${action.from}`);
        if (action.to) attemptLabelParts.push(`to=${action.to}`);
    }
    const attemptLabel = attemptLabelParts.join(' ');

    const resolvedSymbol = normalizeMarketSymbol(action.symbol);
    if (!resolvedSymbol) {
        return {
            attemptLabel,
            success: false,
            sources: [],
            message:
                'Market data tool feedback: invalid symbol. Use known symbols (S&P 500/^spx, Dow/^dji, Nasdaq/^ixic) or a valid Stooq ticker.',
        };
    }

    if (
        (action.date && !normalizeDateInput(action.date)) ||
        (action.from && !normalizeDateInput(action.from)) ||
        (action.to && !normalizeDateInput(action.to))
    ) {
        return {
            attemptLabel,
            success: false,
            sources: [],
            message:
                'Market data tool feedback: invalid date format. Use ISO date format YYYY-MM-DD for date/from/to.',
        };
    }

    const result = await fetchMarketDataFromStooq({
        symbol: resolvedSymbol,
        date: action.date,
        from: action.from,
        to: action.to,
        limit: action.limit,
    });
    if (!result || !result.points.length) {
        return {
            attemptLabel,
            success: false,
            sources: [],
            message:
                `Market data tool results: no rows returned for ${resolvedSymbol.displayName}. ` +
                'Try a different date, a date range, or a different symbol.',
        };
    }

    const lines = [
        `Market data tool results for ${result.symbol.displayName} (${result.symbol.stooqSymbol}):`,
        `Rows returned: ${result.points.length}`,
        ...result.points.map((point, index) => `${index + 1}. ${formatMarketDataPoint(point)}`),
        `Source URL: ${result.sourceUrl}`,
        'If additional evidence is required, request another tool action.',
        'If evidence is sufficient, return final JSON with your answer.',
    ];

    const latest = result.points[0];
    return {
        attemptLabel,
        success: true,
        message: lines.join('\n'),
        sources: [
            {
                title: `Stooq ${result.symbol.displayName} daily data`,
                url: result.sourceUrl,
                snippet: latest ? formatMarketDataPoint(latest) : null,
            },
        ],
    };
}

function shouldValidateRecencyForPrompt(prompt: string): boolean {
    if (!prompt || !RECENCY_PROMPT_PATTERN.test(prompt)) {
        return false;
    }

    return (prompt.match(YEAR_PATTERN) ?? []).length === 0;
}

function answerLooksStaleForRecencyPrompt(prompt: string, answer: string, now = new Date()): boolean {
    if (!shouldValidateRecencyForPrompt(prompt)) {
        return false;
    }

    const years = (answer.match(YEAR_PATTERN) ?? [])
        .map((year) => Number.parseInt(year, 10))
        .filter((year) => Number.isFinite(year));
    if (!years.length) {
        return false;
    }

    const mostRecentYearInAnswer = Math.max(...years);
    return mostRecentYearInAnswer < now.getUTCFullYear();
}

function createOpenAiCompatibleClient(baseURL: string, apiKey?: string): OpenAI {
    const resolvedApiKey = apiKey?.trim() || 'not-required';

    return new OpenAI({
        apiKey: resolvedApiKey,
        baseURL,
        defaultHeaders: {
            'HTTP-Referer': SITE_URL,
            'X-Title': APP_NAME,
        },
    });
}

function extractResponseOutputText(response: OpenAI.Responses.Response): string | null {
    const directOutputText =
        typeof response.output_text === 'string' ? response.output_text.trim() : '';
    if (directOutputText) {
        return directOutputText;
    }

    const chunks: string[] = [];
    const outputItems = Array.isArray(response.output) ? response.output : [];

    for (const outputItem of outputItems) {
        if (typeof outputItem !== 'object' || outputItem === null) continue;

        const content = Array.isArray((outputItem as { content?: unknown }).content)
            ? ((outputItem as { content?: unknown[] }).content ?? [])
            : [];

        for (const part of content) {
            if (typeof part !== 'object' || part === null) continue;
            const candidate = part as { type?: unknown; text?: unknown };
            if (candidate.type === 'output_text' && typeof candidate.text === 'string') {
                chunks.push(candidate.text);
            }
        }
    }

    const joined = chunks.join('').trim();
    return joined.length > 0 ? joined : null;
}

function appendWebSource(
    sourceMap: Map<string, WebSearchSource>,
    source: { title: string; url: string; snippet?: string | null }
): void {
    const url = source.url.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
        return;
    }

    const title = source.title.trim() || url;
    const snippet = typeof source.snippet === 'string' && source.snippet.trim()
        ? source.snippet.trim()
        : null;

    const existing = sourceMap.get(url);
    if (!existing || (!existing.snippet && snippet)) {
        sourceMap.set(url, { title, url, snippet });
    }
}

function extractNativeWebSearchMetadata(response: OpenAI.Responses.Response): ChatReply['webSearch'] {
    const outputItems = Array.isArray(response.output) ? response.output : [];
    const attemptedQueries: string[] = [];
    const attemptedQuerySet = new Set<string>();
    let successfulSearches = 0;
    const sourceMap = new Map<string, WebSearchSource>();

    for (const outputItem of outputItems) {
        if (!isRecord(outputItem)) continue;

        if (outputItem.type === 'web_search_call') {
            if (outputItem.status === 'completed') {
                successfulSearches += 1;
            }

            const action = isRecord(outputItem.action) ? outputItem.action : null;
            if (action && typeof action.query === 'string') {
                const query = action.query.trim();
                if (query) {
                    const key = query.toLowerCase();
                    if (!attemptedQuerySet.has(key)) {
                        attemptedQuerySet.add(key);
                        attemptedQueries.push(query);
                    }
                }
            }

            const rawSources = action && Array.isArray(action.sources) ? action.sources : [];
            for (const rawSource of rawSources) {
                if (!isRecord(rawSource)) continue;
                if (typeof rawSource.url !== 'string') continue;

                appendWebSource(sourceMap, {
                    title: typeof rawSource.title === 'string' ? rawSource.title : rawSource.url,
                    url: rawSource.url,
                    snippet:
                        typeof rawSource.snippet === 'string'
                            ? rawSource.snippet
                            : typeof rawSource.description === 'string'
                              ? rawSource.description
                              : null,
                });
            }
        }

        if (outputItem.type !== 'message') {
            continue;
        }

        const content = Array.isArray(outputItem.content) ? outputItem.content : [];
        for (const part of content) {
            if (!isRecord(part) || part.type !== 'output_text') continue;

            const annotations = Array.isArray(part.annotations) ? part.annotations : [];
            for (const annotation of annotations) {
                if (!isRecord(annotation)) continue;
                if (annotation.type !== 'url_citation') continue;
                if (typeof annotation.url !== 'string') continue;

                appendWebSource(sourceMap, {
                    title:
                        typeof annotation.title === 'string' && annotation.title.trim()
                            ? annotation.title
                            : annotation.url,
                    url: annotation.url,
                    snippet: null,
                });
            }
        }
    }

    const sources = Array.from(sourceMap.values()).slice(0, MAX_WEB_SOURCES_IN_METADATA);
    if (!attemptedQueries.length && !sources.length && successfulSearches === 0) {
        return null;
    }

    return {
        query: attemptedQueries[0] ?? '',
        attemptedQueries,
        successfulSearches,
        sources,
    };
}

async function runChatWithResponsesModel(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[]
): Promise<string> {
    const response = await openai.responses.create({
        model,
        input: messages.map((message) => ({
            role: message.role,
            content: message.content,
        })),
    });

    const content = extractResponseOutputText(response);
    if (!content) {
        throw new Error('Empty response from AI');
    }

    return content;
}

async function runChatWithNativeWebSearch(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[]
): Promise<ModelDrivenSearchResult> {
    const response = await openai.responses.create({
        model,
        input: messages.map((message) => ({
            role: message.role,
            content: message.content,
        })),
        tools: [{ type: 'web_search' as const }],
        tool_choice: 'auto',
        include: ['web_search_call.action.sources'],
    });

    const content = extractResponseOutputText(response);
    if (!content) {
        throw new Error('Empty response from AI');
    }

    return {
        message: content,
        webSearch: extractNativeWebSearchMetadata(response),
    };
}

function extractJsonCandidate(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return trimmed;
    }

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        return fenced[1].trim();
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
        return null;
    }

    return trimmed.slice(firstBrace, lastBrace + 1).trim();
}

function normalizeJsonLikeText(text: string): string {
    return text
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[‐‑‒–—]/g, '-');
}

function extractJsonObjects(text: string): string[] {
    const normalized = normalizeJsonLikeText(text);
    const objects: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaping = false;

    for (let idx = 0; idx < normalized.length; idx += 1) {
        const char = normalized[idx] ?? '';

        if (inString) {
            if (escaping) {
                escaping = false;
                continue;
            }

            if (char === '\\') {
                escaping = true;
                continue;
            }

            if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            if (depth === 0) {
                start = idx;
            }
            depth += 1;
            continue;
        }

        if (char === '}') {
            if (depth <= 0) continue;
            depth -= 1;
            if (depth === 0 && start >= 0) {
                objects.push(normalized.slice(start, idx + 1).trim());
                start = -1;
            }
        }
    }

    if (!objects.length) {
        const single = extractJsonCandidate(normalized);
        if (single) {
            objects.push(single);
        }
    }

    return objects;
}

function isLikelyPlannerProtocolLeak(text: string): boolean {
    return /\b"type"\s*:\s*"(web_search|market_data|final)"|\b(web_search|market_data)\b/i.test(
        text
    );
}

function parseSearchPlannerAction(rawText: string): SearchPlannerAction | null {
    const jsonCandidates = extractJsonObjects(rawText);
    for (const jsonCandidate of jsonCandidates) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(jsonCandidate);
        } catch {
            continue;
        }

        if (!isRecord(parsed) || typeof parsed.type !== 'string') {
            continue;
        }

        if (parsed.type === 'final') {
            const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
            if (!answer) continue;
            return { type: 'final', answer };
        }

        if (parsed.type === 'web_search') {
            const rawQueries = Array.isArray(parsed.queries)
                ? parsed.queries.filter((item): item is string => typeof item === 'string')
                : [];
            if (!rawQueries.length) continue;

            const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
            return { type: 'web_search', queries: rawQueries, reason };
        }

        if (parsed.type === 'market_data') {
            const symbol = typeof parsed.symbol === 'string' ? parsed.symbol.trim() : '';
            if (!symbol) {
                continue;
            }

            const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
            const date = typeof parsed.date === 'string' ? parsed.date.trim() : undefined;
            const from = typeof parsed.from === 'string' ? parsed.from.trim() : undefined;
            const to = typeof parsed.to === 'string' ? parsed.to.trim() : undefined;
            const limit =
                typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)
                    ? parsed.limit
                    : undefined;

            return {
                type: 'market_data',
                symbol,
                date: date || undefined,
                from: from || undefined,
                to: to || undefined,
                limit,
                reason,
            };
        }
    }

    return null;
}

function normalizePlannerQueries(
    queries: readonly string[],
    alreadyTried: ReadonlySet<string>,
    maxQueries: number
): string[] {
    const output: string[] = [];

    for (const rawQuery of queries) {
        const normalizedQuery = buildWebSearchQuery(rawQuery);
        if (!normalizedQuery || normalizedQuery.length < 3) continue;

        const key = normalizedQuery.toLowerCase();
        if (alreadyTried.has(key)) continue;
        if (output.some((query) => query.toLowerCase() === key)) continue;

        output.push(normalizedQuery);
        if (output.length >= maxQueries) {
            break;
        }
    }

    return output;
}

function mergeSource(sourceMap: Map<string, WebSearchSource>, source: WebSearchSource): void {
    const existing = sourceMap.get(source.url);
    if (!existing) {
        sourceMap.set(source.url, source);
        return;
    }

    if (!existing.snippet && source.snippet) {
        sourceMap.set(source.url, source);
    }
}

function toRankedSourcesFromEvidence(evidenceRows: readonly WebSearchEvidence[]): WebSearchSource[] {
    return evidenceRows.map((row) => {
        const baseSnippet = row.evidenceSnippet ?? row.source.snippet;
        const snippetWithDate =
            row.publishedAt && baseSnippet && !baseSnippet.includes(row.publishedAt)
                ? `[${row.publishedAt}] ${baseSnippet}`
                : baseSnippet;

        return {
            title: row.source.title,
            url: row.source.url,
            snippet: snippetWithDate,
        };
    });
}

function formatRoundSearchBlock(query: string, evidenceRows: readonly WebSearchEvidence[]): string {
    const lines = [`Query: ${query}`];

    if (!evidenceRows.length) {
        lines.push('No results returned.');
        return lines.join('\n');
    }

    lines.push('Top evidence-ranked results:');
    for (const [index, row] of evidenceRows.slice(0, 4).entries()) {
        const source = row.source;
        lines.push(`${index + 1}. ${source.title}`);
        lines.push(`URL: ${source.url}`);
        lines.push(
            `Signals: total=${row.totalScore} trust=${row.trustScore} recency=${row.recencyScore}${row.publishedAt ? ` date=${row.publishedAt}` : ''}`
        );
        const bestSnippet = row.evidenceSnippet ?? source.snippet;
        if (bestSnippet) {
            lines.push(`Evidence: ${bestSnippet}`);
        }
    }

    return lines.join('\n');
}

function buildToolResultMessage(args: {
    round: number;
    executedQueries: readonly string[];
    queryBlocks: readonly string[];
    attemptedCount: number;
    successCount: number;
    uniqueSourceCount: number;
    remainingQueries: number;
}): string {
    const lines = [
        `Web search tool results (round ${args.round}):`,
        `Executed queries: ${args.executedQueries.join(' | ')}`,
        `Total attempted queries so far: ${args.attemptedCount}`,
        `Successful searches so far: ${args.successCount}`,
        `Unique sources so far: ${args.uniqueSourceCount}`,
        `Remaining query budget: ${args.remainingQueries}`,
        '',
        ...args.queryBlocks,
        '',
        'If additional evidence is required, return another web_search JSON action.',
        'If evidence is sufficient, return final JSON with your answer.',
    ];

    return lines.join('\n');
}

function buildWebSearchMetadata(
    attemptedQueries: readonly string[],
    successfulSearches: number,
    sourceMap: ReadonlyMap<string, WebSearchSource>
): ChatReply['webSearch'] {
    if (!attemptedQueries.length) {
        return null;
    }

    const sources = Array.from(sourceMap.values())
        .sort((a, b) => {
            const snippetScoreDelta = Number(Boolean(b.snippet)) - Number(Boolean(a.snippet));
            if (snippetScoreDelta !== 0) return snippetScoreDelta;
            return a.url.localeCompare(b.url);
        })
        .slice(0, MAX_WEB_SOURCES_IN_METADATA);

    return {
        query: attemptedQueries[0] ?? '',
        attemptedQueries: [...attemptedQueries],
        successfulSearches,
        sources,
    };
}

async function runChatWithModelDrivenSearch(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[]
): Promise<ModelDrivenSearchResult> {
    const plannerMessages: ChatMessage[] = [
        ...messages,
        { role: 'system', content: MODEL_DRIVEN_WEB_SEARCH_PROMPT },
    ];

    const attemptedQueries: string[] = [];
    const attemptedQuerySet = new Set<string>();
    let successfulSearches = 0;
    const sourceMap = new Map<string, WebSearchSource>();
    const latestUserPrompt = getLatestUserPrompt(messages);
    let recencyValidationRetries = 0;

    for (let round = 1; round <= MAX_MODEL_SEARCH_ROUNDS; round += 1) {
        const plannerOutput = await runChatWithResponsesModel(openai, model, plannerMessages);
        const action = parseSearchPlannerAction(plannerOutput);

        if (!action) {
            if (isLikelyPlannerProtocolLeak(plannerOutput)) {
                return {
                    message:
                        'I hit a tool-formatting error while planning web searches. Please try again.',
                    webSearch: buildWebSearchMetadata(attemptedQueries, successfulSearches, sourceMap),
                };
            }

            return {
                message: plannerOutput,
                webSearch: buildWebSearchMetadata(attemptedQueries, successfulSearches, sourceMap),
            };
        }

        if (action.type === 'final') {
            if (
                recencyValidationRetries < MAX_RECENCY_VALIDATION_RETRIES &&
                answerLooksStaleForRecencyPrompt(latestUserPrompt, action.answer)
            ) {
                recencyValidationRetries += 1;
                plannerMessages.push({ role: 'assistant', content: plannerOutput });

                const now = new Date();
                const absoluteToday = new Intl.DateTimeFormat('en-US', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'UTC',
                }).format(now);

                plannerMessages.push({
                    role: 'user',
                    content: `Validation check: your final answer appears stale for a current-time question. Today is ${absoluteToday} (UTC). Run additional web_search queries focused on current-date sources, then return final JSON.`,
                });
                continue;
            }

            return {
                message: action.answer,
                webSearch: buildWebSearchMetadata(attemptedQueries, successfulSearches, sourceMap),
            };
        }

        plannerMessages.push({ role: 'assistant', content: plannerOutput });

        if (action.type === 'market_data') {
            const marketFeedback = await executeMarketDataTool(action);
            attemptedQueries.push(marketFeedback.attemptLabel);
            if (marketFeedback.success) {
                successfulSearches += 1;
            }

            for (const source of marketFeedback.sources) {
                mergeSource(sourceMap, source);
            }

            await sleep(APP_LAYER_SEARCH_LOOP_DELAY_MS);
            plannerMessages.push({
                role: 'user',
                content: marketFeedback.message,
            });
            continue;
        }

        const remainingQueryBudget = MAX_TOTAL_SEARCH_QUERIES - attemptedQuerySet.size;
        if (remainingQueryBudget <= 0) {
            plannerMessages.push({
                role: 'user',
                content:
                    'Tool feedback: Web search query budget is exhausted. Return {"type":"final","answer":"..."} now.',
            });
            continue;
        }

        const normalizedQueries = normalizePlannerQueries(
            action.queries,
            attemptedQuerySet,
            Math.min(MAX_SEARCH_QUERIES_PER_ROUND, remainingQueryBudget)
        );

        if (!normalizedQueries.length) {
            plannerMessages.push({
                role: 'user',
                content:
                    'Tool feedback: No usable new queries were provided (duplicates/empty). Return final JSON or request different queries.',
            });
            continue;
        }

        const queryBlocks: string[] = [];

        for (const query of normalizedQueries) {
            attemptedQueries.push(query);
            attemptedQuerySet.add(query.toLowerCase());

            const results = await searchWeb(query, { maxResults: SEARCH_RESULTS_PER_QUERY });
            const evidenceRows = await enrichAndRankSources(query, results, {
                maxSourcesToFetch: 3,
            });
            const rankedSources = toRankedSourcesFromEvidence(evidenceRows).slice(0, SEARCH_RESULTS_PER_QUERY);

            if (rankedSources.length > 0) {
                successfulSearches += 1;
            }

            for (const source of rankedSources) {
                mergeSource(sourceMap, source);
            }

            queryBlocks.push(formatRoundSearchBlock(query, evidenceRows));
        }

        // Throttle round-trip cadence before returning tool results to the model.
        await sleep(APP_LAYER_SEARCH_LOOP_DELAY_MS);

        plannerMessages.push({
            role: 'user',
            content: buildToolResultMessage({
                round,
                executedQueries: normalizedQueries,
                queryBlocks,
                attemptedCount: attemptedQuerySet.size,
                successCount: successfulSearches,
                uniqueSourceCount: sourceMap.size,
                remainingQueries: Math.max(0, MAX_TOTAL_SEARCH_QUERIES - attemptedQuerySet.size),
            }),
        });
    }

    plannerMessages.push({
        role: 'user',
        content:
            'Tool feedback: Search loop limit reached. Return {"type":"final","answer":"..."} now. Do not request more searches.',
    });

    const forcedFinalOutput = await runChatWithResponsesModel(openai, model, plannerMessages);
    const forcedAction = parseSearchPlannerAction(forcedFinalOutput);
    const fallbackFinalMessage =
        forcedAction?.type === 'final' && forcedAction.answer ? forcedAction.answer : forcedFinalOutput;

    return {
        message: fallbackFinalMessage,
        webSearch: buildWebSearchMetadata(attemptedQueries, successfulSearches, sourceMap),
    };
}

async function runChatWithWebStrategy(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[]
): Promise<ModelDrivenSearchResult> {
    if (!isNativeWebSearchModel(model)) {
        return runChatWithModelDrivenSearch(openai, model, messages);
    }

    try {
        return await runChatWithNativeWebSearch(openai, model, messages);
    } catch (error) {
        if (!isUnsupportedWebSearchError(error)) {
            throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn('Model rejected native web_search tool; falling back to app-layer search', {
            model,
            error: errorMessage,
        });

        return runChatWithModelDrivenSearch(openai, model, messages);
    }
}

function normalizeModelList(models: string[]): string[] {
    return Array.from(
        new Set(
            models
                .map((model) => model.trim())
                .filter((model): model is string => model.length > 0)
        )
    );
}

export async function generateChatReply(
    messages: readonly ChatMessage[],
    options?: { primaryModel?: string | null }
): Promise<ChatReply> {
    if (!messages.length) {
        throw new Error('No chat messages were provided');
    }

    const candidatePrimaryModel =
        typeof options?.primaryModel === 'string' && options.primaryModel.trim()
            ? options.primaryModel.trim()
            : PRIMARY_LLM_MODEL;
    const selectedPrimaryModel = isAllowedPrimaryModel(candidatePrimaryModel)
        ? candidatePrimaryModel
        : PRIMARY_LLM_MODEL;

    try {
        const primaryClient = createOpenAiCompatibleClient(PRIMARY_LLM_BASE_URL, PRIMARY_LLM_API_KEY);
        const primaryResult = await runChatWithWebStrategy(
            primaryClient,
            selectedPrimaryModel,
            messages
        );

        return {
            message: primaryResult.message,
            provider: 'ngrok-openai-compatible',
            model: selectedPrimaryModel,
            webSearch: primaryResult.webSearch,
        };
    } catch (primaryError) {
        const primaryErrorMessage =
            primaryError instanceof Error ? primaryError.message : String(primaryError);

        console.warn('Primary chat model failed, falling back to OpenRouter', {
            baseURL: PRIMARY_LLM_BASE_URL,
            model: selectedPrimaryModel,
            error: primaryErrorMessage,
        });

        if (!OPENROUTER_API_KEY) {
            throw new Error(
                `Primary chat model failed and OpenRouter fallback is not configured. Primary error: ${primaryErrorMessage}`
            );
        }

        const fallbackClient = createOpenAiCompatibleClient(OPENROUTER_BASE_URL, OPENROUTER_API_KEY);
        const fallbackModels = normalizeModelList([OPENROUTER_MODEL, OPENROUTER_BACKUP_MODEL]);
        const fallbackFailures: string[] = [];

        for (const fallbackModel of fallbackModels) {
            try {
                const fallbackResult = await runChatWithWebStrategy(
                    fallbackClient,
                    fallbackModel,
                    messages
                );

                if (fallbackModel !== OPENROUTER_MODEL) {
                    console.warn('Primary OpenRouter chat fallback failed; backup model succeeded', {
                        primaryFallbackModel: OPENROUTER_MODEL,
                        backupFallbackModel: fallbackModel,
                    });
                }

                return {
                    message: fallbackResult.message,
                    provider: 'openrouter',
                    model: fallbackModel,
                    webSearch: fallbackResult.webSearch,
                };
            } catch (fallbackError) {
                const fallbackErrorMessage =
                    fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                fallbackFailures.push(`${fallbackModel}: ${fallbackErrorMessage}`);
                console.warn('OpenRouter chat fallback model failed', {
                    model: fallbackModel,
                    error: fallbackErrorMessage,
                });
            }
        }

        throw new Error(
            `Primary chat model failed (${primaryErrorMessage}) and OpenRouter fallback failed (${fallbackFailures.join(
                ' | '
            )})`
        );
    }
}
