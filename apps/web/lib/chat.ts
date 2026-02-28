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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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

function parseSearchPlannerAction(rawText: string): SearchPlannerAction | null {
    const jsonCandidate = extractJsonCandidate(rawText);
    if (!jsonCandidate) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonCandidate);
    } catch {
        return null;
    }

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        return null;
    }

    if (parsed.type === 'final') {
        const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
        if (!answer) return null;
        return { type: 'final', answer };
    }

    if (parsed.type === 'web_search') {
        const rawQueries = Array.isArray(parsed.queries)
            ? parsed.queries.filter((item): item is string => typeof item === 'string')
            : [];
        if (!rawQueries.length) return null;

        const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
        return { type: 'web_search', queries: rawQueries, reason };
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

    for (let round = 1; round <= MAX_MODEL_SEARCH_ROUNDS; round += 1) {
        const plannerOutput = await runChatWithResponsesModel(openai, model, plannerMessages);
        const action = parseSearchPlannerAction(plannerOutput);

        if (!action) {
            return {
                message: plannerOutput,
                webSearch: buildWebSearchMetadata(attemptedQueries, successfulSearches, sourceMap),
            };
        }

        if (action.type === 'final') {
            return {
                message: action.answer,
                webSearch: buildWebSearchMetadata(attemptedQueries, successfulSearches, sourceMap),
            };
        }

        plannerMessages.push({ role: 'assistant', content: plannerOutput });

        const remainingQueryBudget = MAX_TOTAL_SEARCH_QUERIES - attemptedQueries.length;
        if (remainingQueryBudget <= 0) {
            plannerMessages.push({
                role: 'system',
                content:
                    'Web search query budget is exhausted. Return {"type":"final","answer":"..."} now.',
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
                role: 'system',
                content:
                    'No usable new queries were provided (duplicates/empty). Return final JSON or request different queries.',
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

        plannerMessages.push({
            role: 'system',
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
        role: 'system',
        content:
            'Search loop limit reached. Return {"type":"final","answer":"..."} now. Do not request more searches.',
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
        const primaryResult = await runChatWithModelDrivenSearch(
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
                const fallbackResult = await runChatWithModelDrivenSearch(
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
