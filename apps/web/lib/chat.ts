import OpenAI from 'openai';
import { isUsablePrimaryModel } from '@/lib/model-settings';

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

const MAX_WEB_SOURCES_IN_METADATA = 8;
const NATIVE_WEB_SEARCH_MODELS = new Set(['gpt-5', 'gpt-5.1', 'gpt-5.2']);

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
    role: ChatRole;
    content: string;
};

type WebSearchSource = {
    title: string;
    url: string;
    snippet?: string | null;
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

export type ChatReplyStreamChunk =
    | {
          type: 'delta';
          text: string;
      }
    | {
          type: 'done';
          reply: ChatReply;
      };

type ModelDrivenSearchResult = {
    message: string;
    webSearch: ChatReply['webSearch'];
};

type ChatRequestOptions = Pick<OpenAI.RequestOptions, 'signal'>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNativeWebSearchModel(model: string): boolean {
    return NATIVE_WEB_SEARCH_MODELS.has(model);
}

function isAllowedRuntimePrimaryModel(value: string): boolean {
    return isUsablePrimaryModel(value);
}

function isUnsupportedWebSearchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unsupported tool type:\s*web_search|web_search|tool_choice|invalid.*tools?|unknown tool/i.test(
        message
    );
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

function toResponseInput(messages: readonly ChatMessage[]) {
    return messages.map((message) => ({
        role: message.role,
        content: message.content,
    }));
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

function extractResponseFailureMessage(response: OpenAI.Responses.Response): string | null {
    const error = response.error;
    if (error?.message) {
        return error.message;
    }

    if (response.status === 'incomplete' && response.incomplete_details?.reason) {
        return `Incomplete response: ${response.incomplete_details.reason}`;
    }

    if (response.status === 'failed') {
        return 'AI response failed';
    }

    return null;
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
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions
): Promise<string> {
    const response = await openai.responses.create(
        {
            model,
            input: toResponseInput(messages),
        },
        options
    );

    const content = extractResponseOutputText(response);
    if (!content) {
        throw new Error('Empty response from AI');
    }

    return content;
}

async function runChatWithNativeWebSearch(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions
): Promise<ModelDrivenSearchResult> {
    const response = await openai.responses.create(
        {
            model,
            input: toResponseInput(messages),
            tools: [{ type: 'web_search' as const }],
            tool_choice: 'auto',
            include: ['web_search_call.action.sources'],
        },
        options
    );

    const content = extractResponseOutputText(response);
    if (!content) {
        throw new Error('Empty response from AI');
    }

    return {
        message: content,
        webSearch: extractNativeWebSearchMetadata(response),
    };
}

async function runChatWithoutTools(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions
): Promise<ModelDrivenSearchResult> {
    return {
        message: await runChatWithResponsesModel(openai, model, messages, options),
        webSearch: null,
    };
}

async function runChatWithWebStrategy(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions
): Promise<ModelDrivenSearchResult> {
    if (!isNativeWebSearchModel(model)) {
        return runChatWithoutTools(openai, model, messages, options);
    }

    try {
        return await runChatWithNativeWebSearch(openai, model, messages, options);
    } catch (error) {
        if (!isUnsupportedWebSearchError(error)) {
            throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn('Model rejected native web_search tool; falling back to plain responses', {
            model,
            error: errorMessage,
        });

        return runChatWithoutTools(openai, model, messages, options);
    }
}

async function* runChatWithResponsesModelStream(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions,
    onDelta?: () => void
): AsyncGenerator<ChatReplyStreamChunk, string, void> {
    const stream = openai.responses.stream(
        {
            model,
            input: toResponseInput(messages),
        },
        options
    );
    const chunks: string[] = [];
    let completedResponse: OpenAI.Responses.Response | null = null;
    let finalizedText: string | null = null;

    for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
            if (event.delta) {
                chunks.push(event.delta);
                onDelta?.();
                yield { type: 'delta', text: event.delta };
            }
            continue;
        }

        if (event.type === 'response.output_text.done') {
            finalizedText = event.text;
            continue;
        }

        if (event.type === 'response.completed') {
            completedResponse = event.response;
            continue;
        }

        if (event.type === 'response.failed' || event.type === 'response.incomplete') {
            throw new Error(extractResponseFailureMessage(event.response) ?? 'AI response failed');
        }

        if (event.type === 'error') {
            throw new Error(event.message || 'AI response stream failed');
        }
    }

    const completedText = completedResponse ? extractResponseOutputText(completedResponse) : null;
    const finalizedOutputText = finalizedText?.trim();
    const streamedText = chunks.join('').trim();
    const content = completedText ?? (finalizedOutputText || null) ?? streamedText;
    if (!content) {
        throw new Error('Empty response from AI');
    }

    return content;
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
    options?: { primaryModel?: string | null; signal?: AbortSignal }
): Promise<ChatReply> {
    if (!messages.length) {
        throw new Error('No chat messages were provided');
    }

    const candidatePrimaryModel =
        typeof options?.primaryModel === 'string' && options.primaryModel.trim()
            ? options.primaryModel.trim()
            : PRIMARY_LLM_MODEL;
    const selectedPrimaryModel = isAllowedRuntimePrimaryModel(candidatePrimaryModel)
        ? candidatePrimaryModel
        : PRIMARY_LLM_MODEL;

    try {
        const primaryClient = createOpenAiCompatibleClient(PRIMARY_LLM_BASE_URL, PRIMARY_LLM_API_KEY);
        const primaryResult = await runChatWithWebStrategy(
            primaryClient,
            selectedPrimaryModel,
            messages,
            { signal: options?.signal }
        );

        return {
            message: primaryResult.message,
            provider: 'ngrok-openai-compatible',
            model: selectedPrimaryModel,
            webSearch: primaryResult.webSearch,
        };
    } catch (primaryError) {
        if (options?.signal?.aborted) {
            throw primaryError;
        }

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
                    messages,
                    { signal: options?.signal }
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
                if (options?.signal?.aborted) {
                    throw fallbackError;
                }

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

export async function* generateChatReplyStream(
    messages: readonly ChatMessage[],
    options?: { primaryModel?: string | null; signal?: AbortSignal }
): AsyncGenerator<ChatReplyStreamChunk, void, void> {
    if (!messages.length) {
        throw new Error('No chat messages were provided');
    }

    const candidatePrimaryModel =
        typeof options?.primaryModel === 'string' && options.primaryModel.trim()
            ? options.primaryModel.trim()
            : PRIMARY_LLM_MODEL;
    const selectedPrimaryModel = isAllowedRuntimePrimaryModel(candidatePrimaryModel)
        ? candidatePrimaryModel
        : PRIMARY_LLM_MODEL;

    try {
        const primaryClient = createOpenAiCompatibleClient(PRIMARY_LLM_BASE_URL, PRIMARY_LLM_API_KEY);
        const primaryResult = await runChatWithWebStrategy(
            primaryClient,
            selectedPrimaryModel,
            messages,
            { signal: options?.signal }
        );
        const reply: ChatReply = {
            message: primaryResult.message,
            provider: 'ngrok-openai-compatible',
            model: selectedPrimaryModel,
            webSearch: primaryResult.webSearch,
        };

        yield { type: 'delta', text: reply.message };
        yield { type: 'done', reply };
        return;
    } catch (primaryError) {
        const primaryErrorMessage =
            primaryError instanceof Error ? primaryError.message : String(primaryError);

        console.warn('Primary chat model failed, falling back to streaming OpenRouter', {
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
            let emittedFallbackContent = false;

            try {
                const message = yield* runChatWithResponsesModelStream(
                    fallbackClient,
                    fallbackModel,
                    messages,
                    { signal: options?.signal },
                    () => {
                        emittedFallbackContent = true;
                    }
                );

                if (fallbackModel !== OPENROUTER_MODEL) {
                    console.warn('Primary OpenRouter chat fallback failed; backup model succeeded', {
                        primaryFallbackModel: OPENROUTER_MODEL,
                        backupFallbackModel: fallbackModel,
                    });
                }

                yield {
                    type: 'done',
                    reply: {
                        message,
                        provider: 'openrouter',
                        model: fallbackModel,
                        webSearch: null,
                    },
                };
                return;
            } catch (fallbackError) {
                const fallbackErrorMessage =
                    fallbackError instanceof Error ? fallbackError.message : String(fallbackError);

                if (emittedFallbackContent) {
                    throw new Error(
                        `OpenRouter chat stream failed after response started: ${fallbackErrorMessage}`
                    );
                }

                fallbackFailures.push(`${fallbackModel}: ${fallbackErrorMessage}`);
                console.warn('OpenRouter chat fallback model failed before streaming content', {
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
