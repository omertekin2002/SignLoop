import OpenAI from 'openai';
import { isAllowedPrimaryModel } from '@/lib/model-settings';
import {
    buildWebSearchQuery,
    searchWeb,
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

const DATE_OR_TIME_PROMPT_PATTERN =
    /\b(what day is it|what(?:'s| is) (?:the )?date|today'?s date|current date|what time is it|current time|time now)\b/i;
const CLOSE_PRICE_PROMPT_PATTERN = /\b(close|closed|closing|last close|close at)\b/i;
const RECENCY_PROMPT_PATTERN = /\b(today|now|latest|current|currently|as of)\b/i;
const YEAR_PATTERN = /\b(19|20)\d{2}\b/g;

const MODEL_DRIVEN_WEB_SEARCH_PROMPT = `
You can use an application-level web search tool in this chat.

Return exactly one JSON object and nothing else on every response:
- To search the web: {"type":"web_search","queries":["query 1","query 2"],"reason":"short reason"}
- To answer the user: {"type":"final","answer":"your user-facing answer"}

Rules:
- Use web_search only when current, external, or uncertain facts need verification.
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
    | { type: 'final'; answer: string };

type ModelDrivenSearchResult = {
    message: string;
    webSearch: ChatReply['webSearch'];
};

type DeterministicChatResult = {
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

function isValidIanaTimezone(value: string): boolean {
    try {
        Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

function resolveTimeZoneForPrompt(prompt: string): string {
    const ianaMatch = prompt.match(/\b(?:in|for)\s+([A-Za-z_]+\/[A-Za-z0-9_+-]+)\b/);
    const candidate = ianaMatch?.[1]?.trim();
    if (candidate && isValidIanaTimezone(candidate)) {
        return candidate;
    }

    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function maybeResolveCurrentDateOrTimePrompt(prompt: string): DeterministicChatResult | null {
    if (!DATE_OR_TIME_PROMPT_PATTERN.test(prompt)) {
        return null;
    }

    const timeZone = resolveTimeZoneForPrompt(prompt);
    const now = new Date();
    const dateText = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).format(now);
    const timeText = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(now);

    const asksTime = /\b(what time is it|current time|time now)\b/i.test(prompt);
    const asksDate = /\b(what day is it|what(?:'s| is) (?:the )?date|today'?s date|current date)\b/i.test(
        prompt
    );

    if (asksTime && asksDate) {
        return {
            message: `Current date and time in ${timeZone}: ${dateText}, ${timeText}.`,
            webSearch: null,
        };
    }

    if (asksTime) {
        return {
            message: `Current time in ${timeZone}: ${timeText} on ${dateText}.`,
            webSearch: null,
        };
    }

    return {
        message: `Today is ${dateText} in ${timeZone}.`,
        webSearch: null,
    };
}

type MarketCloseRequest = {
    displayName: string;
    stooqSymbol: string;
};

function detectMarketCloseRequest(prompt: string): MarketCloseRequest | null {
    if (!CLOSE_PRICE_PROMPT_PATTERN.test(prompt)) {
        return null;
    }

    const normalized = prompt.toLowerCase();

    if (/\b(s&p\s*500|s and p\s*500|sp500|spx|\^gspc|\^spx)\b/.test(normalized)) {
        return { displayName: 'S&P 500', stooqSymbol: '^spx' };
    }

    if (/\b(dow jones|djia|\^dji)\b/.test(normalized)) {
        return { displayName: 'Dow Jones Industrial Average', stooqSymbol: '^dji' };
    }

    if (/\b(nasdaq(?: composite)?|ixic|\^ixic)\b/.test(normalized)) {
        return { displayName: 'NASDAQ Composite', stooqSymbol: '^ixic' };
    }

    return null;
}

type MarketCloseSnapshot = {
    close: number;
    isoDate: string;
    sourceUrl: string;
};

function parseStooqDailyCloseCsv(csvLine: string, stooqSymbol: string): MarketCloseSnapshot | null {
    const columns = csvLine.split(',').map((value) => value.trim());
    if (columns.length < 7) {
        return null;
    }

    const rawDate = columns[1] ?? '';
    const rawClose = columns[6] ?? '';
    if (!/^\d{8}$/.test(rawDate) || rawClose === 'N/D') {
        return null;
    }

    const close = Number.parseFloat(rawClose);
    if (!Number.isFinite(close)) {
        return null;
    }

    const isoDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    const sourceUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;

    return { close, isoDate, sourceUrl };
}

async function fetchMarketCloseFromStooq(stooqSymbol: string): Promise<MarketCloseSnapshot | null> {
    try {
        const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            return null;
        }

        const body = (await response.text()).trim();
        const firstLine = body.split('\n')[0]?.trim() ?? '';
        if (!firstLine) {
            return null;
        }

        return parseStooqDailyCloseCsv(firstLine, stooqSymbol);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn('Market close fetch failed:', { symbol: stooqSymbol, error: errorMessage });
        return null;
    }
}

function formatIsoDateForAnswer(isoDate: string): string {
    const parts = isoDate.split('-').map((value) => Number.parseInt(value, 10));
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    if (
        parts.length !== 3 ||
        year === undefined ||
        month === undefined ||
        day === undefined ||
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        !Number.isFinite(day)
    ) {
        return isoDate;
    }

    const asDate = new Date(Date.UTC(year, month - 1, day));
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).format(asDate);
}

async function maybeResolveMarketClosePrompt(prompt: string): Promise<DeterministicChatResult | null> {
    const request = detectMarketCloseRequest(prompt);
    if (!request) {
        return null;
    }

    const snapshot = await fetchMarketCloseFromStooq(request.stooqSymbol);
    if (!snapshot) {
        return null;
    }

    const formattedClose = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(snapshot.close);
    const formattedDate = formatIsoDateForAnswer(snapshot.isoDate);

    return {
        message: `The latest available ${request.displayName} close is ${formattedClose} on ${formattedDate} (UTC session date), based on [Stooq](${snapshot.sourceUrl}).`,
        webSearch: {
            query: `${request.displayName} latest close`,
            attemptedQueries: [`stooq ${request.stooqSymbol} daily close`],
            successfulSearches: 1,
            sources: [
                {
                    title: `Stooq ${request.displayName} daily close`,
                    url: snapshot.sourceUrl,
                    snippet: `Close ${formattedClose} on ${snapshot.isoDate}`,
                },
            ],
        },
    };
}

async function maybeResolveDeterministicPrompt(
    messages: readonly ChatMessage[]
): Promise<DeterministicChatResult | null> {
    const latestUserPrompt = getLatestUserPrompt(messages);
    if (!latestUserPrompt) {
        return null;
    }

    const dateOrTime = maybeResolveCurrentDateOrTimePrompt(latestUserPrompt);
    if (dateOrTime) {
        return dateOrTime;
    }

    return maybeResolveMarketClosePrompt(latestUserPrompt);
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
    return /\b"type"\s*:\s*"(web_search|final)"|\bweb_search\b/i.test(text);
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

function formatRoundSearchBlock(query: string, sources: readonly WebSearchSource[]): string {
    const lines = [`Query: ${query}`];

    if (!sources.length) {
        lines.push('No results returned.');
        return lines.join('\n');
    }

    lines.push('Top results:');
    for (const [index, source] of sources.slice(0, 4).entries()) {
        lines.push(`${index + 1}. ${source.title}`);
        lines.push(`URL: ${source.url}`);
        if (source.snippet) {
            lines.push(`Snippet: ${source.snippet}`);
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

        const remainingQueryBudget = MAX_TOTAL_SEARCH_QUERIES - attemptedQueries.length;
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
            if (results.length > 0) {
                successfulSearches += 1;
            }

            for (const source of results) {
                mergeSource(sourceMap, source);
            }

            queryBlocks.push(formatRoundSearchBlock(query, results));
        }

        // Throttle round-trip cadence before returning tool results to the model.
        await sleep(APP_LAYER_SEARCH_LOOP_DELAY_MS);

        plannerMessages.push({
            role: 'user',
            content: buildToolResultMessage({
                round,
                executedQueries: normalizedQueries,
                queryBlocks,
                attemptedCount: attemptedQueries.length,
                successCount: successfulSearches,
                uniqueSourceCount: sourceMap.size,
                remainingQueries: Math.max(0, MAX_TOTAL_SEARCH_QUERIES - attemptedQueries.length),
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
    const deterministicResult = await maybeResolveDeterministicPrompt(messages);
    if (deterministicResult) {
        return {
            message: deterministicResult.message,
            provider: 'ngrok-openai-compatible',
            model: selectedPrimaryModel,
            webSearch: deterministicResult.webSearch,
        };
    }

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
