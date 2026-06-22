import OpenAI from 'openai';
import {
    APP_NAME,
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    OPENROUTER_MODELS,
    PRIMARY_LLM_API_KEY,
    PRIMARY_LLM_BASE_URL,
    SITE_URL,
    createOpenAiCompatibleClient,
    extractResponseOutputText,
    resolvePrimaryModel,
    runWithPrimaryAndOpenRouterFallback,
} from '@/lib/llm-client';

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

function isUnsupportedWebSearchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    // Only treat the error as an unsupported-tool signal when it explicitly references an
    // unsupported/unknown/invalid tool — a bare "web_search" substring is too broad and would
    // misclassify unrelated failures (rate limits, server errors) that echo the tool name.
    return /unsupported tool type:\s*web_search|unknown tool|invalid[^.]*tools?|web_search[^.]*not\s+support/i.test(
        message
    );
}

function toResponseInput(messages: readonly ChatMessage[]) {
    return messages.map((message) => ({
        role: message.role,
        content: message.content,
    }));
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

function getOpenRouterResponsesUrl(): string {
    return `${OPENROUTER_BASE_URL.replace(/\/+$/, '')}/responses`;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function extractOpenRouterErrorMessage(status: number, body: string): string {
    const payload = parseJsonRecord(body);
    const error = isRecord(payload?.error) ? payload.error : null;
    const message =
        typeof error?.message === 'string'
            ? error.message
            : typeof payload?.message === 'string'
              ? payload.message
              : body.trim();

    return `${status} ${message || 'OpenRouter request failed'}`.slice(0, 1200);
}

function extractSseDataPayload(block: string): string | null {
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) {
            continue;
        }

        const separatorIndex = line.indexOf(':');
        const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
        const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
        const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

        if (field === 'data') {
            dataLines.push(value);
        }
    }

    return dataLines.length ? dataLines.join('\n') : null;
}

async function* readSseDataPayloads(
    body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (value) {
            buffer += decoder.decode(value, { stream: !done });
            buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        }
        if (done) {
            buffer += decoder.decode();
            buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        }

        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
            const block = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);

            const payload = extractSseDataPayload(block);
            if (payload) {
                yield payload;
            }

            separatorIndex = buffer.indexOf('\n\n');
        }

        if (done) {
            const trailingPayload = extractSseDataPayload(buffer);
            if (trailingPayload) {
                yield trailingPayload;
            }
            return;
        }
    }
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

async function* runOpenRouterResponsesModelStream(
    model: string,
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions,
    onDelta?: () => void
): AsyncGenerator<ChatReplyStreamChunk, string, void> {
    if (!OPENROUTER_API_KEY) {
        throw new Error('OpenRouter fallback is not configured');
    }

    const response = await fetch(getOpenRouterResponsesUrl(), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': SITE_URL,
            'X-Title': APP_NAME,
        },
        body: JSON.stringify({
            model,
            input: toResponseInput(messages),
            stream: true,
        }),
        signal: options?.signal,
    });

    if (!response.ok) {
        throw new Error(extractOpenRouterErrorMessage(response.status, await response.text()));
    }

    if (!response.body) {
        throw new Error('OpenRouter response stream was empty');
    }

    const chunks: string[] = [];
    let completedResponse: OpenAI.Responses.Response | null = null;
    let finalizedText: string | null = null;

    for await (const payload of readSseDataPayloads(response.body)) {
        if (payload === '[DONE]') {
            break;
        }

        const event = parseJsonRecord(payload);
        if (!event) {
            continue;
        }

        const eventType = typeof event.type === 'string' ? event.type : '';

        if (eventType === 'response.keep_alive') {
            continue;
        }

        if (eventType === 'response.output_text.delta') {
            const delta = typeof event.delta === 'string' ? event.delta : '';
            if (delta) {
                chunks.push(delta);
                onDelta?.();
                yield { type: 'delta', text: delta };
            }
            continue;
        }

        if (eventType === 'response.output_text.done') {
            finalizedText = typeof event.text === 'string' ? event.text : null;
            continue;
        }

        if (eventType === 'response.completed') {
            if (isRecord(event.response)) {
                completedResponse = event.response as unknown as OpenAI.Responses.Response;
            }
            continue;
        }

        if (eventType === 'response.failed' || eventType === 'response.incomplete') {
            const failedResponse = isRecord(event.response)
                ? (event.response as unknown as OpenAI.Responses.Response)
                : null;
            throw new Error(
                failedResponse
                    ? (extractResponseFailureMessage(failedResponse) ?? 'AI response failed')
                    : 'AI response failed'
            );
        }

        if (eventType === 'error') {
            const error = isRecord(event.error) ? event.error : null;
            const message =
                typeof event.message === 'string'
                    ? event.message
                    : typeof error?.message === 'string'
                      ? error.message
                      : 'AI response stream failed';
            throw new Error(message);
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

export async function generateChatReply(
    messages: readonly ChatMessage[],
    options?: { primaryModel?: string | null; signal?: AbortSignal }
): Promise<ChatReply> {
    if (!messages.length) {
        throw new Error('No chat messages were provided');
    }

    const selectedPrimaryModel = resolvePrimaryModel(options?.primaryModel);

    const { result, provider, model } = await runWithPrimaryAndOpenRouterFallback(
        selectedPrimaryModel,
        (client, runModel) =>
            runChatWithWebStrategy(client, runModel, messages, { signal: options?.signal }),
        { signal: options?.signal }
    );

    return {
        message: result.message,
        provider,
        model,
        webSearch: result.webSearch,
    };
}

async function* runPrimaryResponsesModelStream(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[],
    options?: ChatRequestOptions,
    onDelta?: () => void
): AsyncGenerator<ChatReplyStreamChunk, string, void> {
    const stream = await openai.responses.create(
        {
            model,
            input: toResponseInput(messages),
            stream: true,
        },
        options
    );

    const chunks: string[] = [];
    let completedResponse: OpenAI.Responses.Response | null = null;
    let finalizedText: string | null = null;

    for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
            const delta = typeof event.delta === 'string' ? event.delta : '';
            if (delta) {
                chunks.push(delta);
                onDelta?.();
                yield { type: 'delta', text: delta };
            }
            continue;
        }

        if (event.type === 'response.output_text.done') {
            finalizedText = typeof event.text === 'string' ? event.text : null;
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
            const message =
                typeof event.message === 'string' ? event.message : 'AI response stream failed';
            throw new Error(message);
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

export async function* generateChatReplyStream(
    messages: readonly ChatMessage[],
    options?: { primaryModel?: string | null; signal?: AbortSignal }
): AsyncGenerator<ChatReplyStreamChunk, void, void> {
    if (!messages.length) {
        throw new Error('No chat messages were provided');
    }

    const selectedPrimaryModel = resolvePrimaryModel(options?.primaryModel);

    let primaryEmittedContent = false;

    try {
        const primaryClient = createOpenAiCompatibleClient(PRIMARY_LLM_BASE_URL, PRIMARY_LLM_API_KEY);

        if (isNativeWebSearchModel(selectedPrimaryModel)) {
            // Native web search needs the full response to attach source links, so this path
            // resolves the complete reply and emits it as a single chunk.
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
        }

        // Non-web-search models stream token by token directly from the primary endpoint.
        const message = yield* runPrimaryResponsesModelStream(
            primaryClient,
            selectedPrimaryModel,
            messages,
            { signal: options?.signal },
            () => {
                primaryEmittedContent = true;
            }
        );

        yield {
            type: 'done',
            reply: {
                message,
                provider: 'ngrok-openai-compatible',
                model: selectedPrimaryModel,
                webSearch: null,
            },
        };
        return;
    } catch (primaryError) {
        if (options?.signal?.aborted) {
            throw primaryError;
        }

        const primaryErrorMessage =
            primaryError instanceof Error ? primaryError.message : String(primaryError);

        // If the primary stream already emitted tokens, restarting on a fallback model would
        // duplicate visible content, so surface a hard error instead of falling through.
        if (primaryEmittedContent) {
            throw new Error(
                `Primary chat stream failed after response started: ${primaryErrorMessage}`
            );
        }

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

        const fallbackModels = OPENROUTER_MODELS;
        const fallbackFailures: string[] = [];

        for (const fallbackModel of fallbackModels) {
            let emittedFallbackContent = false;

            try {
                const message = yield* runOpenRouterResponsesModelStream(
                    fallbackModel,
                    messages,
                    { signal: options?.signal },
                    () => {
                        emittedFallbackContent = true;
                    }
                );

                if (fallbackModel !== fallbackModels[0]) {
                    console.warn('OpenRouter chat fallback model succeeded after earlier model failed', {
                        firstFallbackModel: fallbackModels[0],
                        successfulFallbackModel: fallbackModel,
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
                if (options?.signal?.aborted) {
                    throw fallbackError;
                }

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
