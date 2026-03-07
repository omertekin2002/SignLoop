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
const CHAT_COMPLETIONS_IMAGE_MODELS = new Set(['gemini-3.1-flash-image']);

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

function isChatCompletionsImageModel(model: string): boolean {
    if (CHAT_COMPLETIONS_IMAGE_MODELS.has(model)) {
        return true;
    }

    return model.toLowerCase().endsWith('/gemini-3.1-flash-image');
}

function isAllowedRuntimePrimaryModel(value: string): boolean {
    return isUsablePrimaryModel(value) || isChatCompletionsImageModel(value);
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

function isLikelyBase64ImagePayload(value: string): boolean {
    const compact = value.replace(/\s+/g, '');
    if (compact.length < 512 || compact.length % 4 !== 0) {
        return false;
    }

    return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function normalizeImageCandidate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
        return trimmed;
    }

    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }

    if (isLikelyBase64ImagePayload(trimmed)) {
        return `data:image/png;base64,${trimmed.replace(/\s+/g, '')}`;
    }

    return null;
}

function pushImageCandidate(
    value: unknown,
    imageUrls: string[],
    imageUrlSet: Set<string>
): void {
    if (typeof value !== 'string') {
        return;
    }

    const normalized = normalizeImageCandidate(value);
    if (!normalized || imageUrlSet.has(normalized)) {
        return;
    }

    imageUrlSet.add(normalized);
    imageUrls.push(normalized);
}

function pushTextCandidate(value: unknown, textChunks: string[]): void {
    if (typeof value !== 'string') {
        return;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return;
    }

    textChunks.push(trimmed);
}

function extractCompletionMessageContent(
    completion: OpenAI.Chat.Completions.ChatCompletion
): string | null {
    const firstChoice = completion.choices[0];
    const message = firstChoice?.message;
    if (!message) {
        return null;
    }

    const textChunks: string[] = [];
    const imageUrls: string[] = [];
    const imageUrlSet = new Set<string>();

    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
        const maybeImage = normalizeImageCandidate(content);
        if (maybeImage) {
            pushImageCandidate(maybeImage, imageUrls, imageUrlSet);
        } else {
            pushTextCandidate(content, textChunks);
        }
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (!isRecord(part)) {
                continue;
            }

            const partType = typeof part.type === 'string' ? part.type : '';

            if (partType === 'text' || partType === 'output_text') {
                pushTextCandidate(part.text, textChunks);
            }

            if (partType === 'image_url' || partType === 'output_image' || partType === 'image') {
                const imageUrlCandidate = isRecord(part.image_url) ? part.image_url.url : part.image_url;
                pushImageCandidate(imageUrlCandidate, imageUrls, imageUrlSet);
                pushImageCandidate(part.url, imageUrls, imageUrlSet);
                pushImageCandidate(part.b64_json, imageUrls, imageUrlSet);
                pushImageCandidate(part.data, imageUrls, imageUrlSet);
            }

            pushImageCandidate(part.b64_json, imageUrls, imageUrlSet);
            pushImageCandidate(part.data, imageUrls, imageUrlSet);
        }
    }

    if (isRecord(message)) {
        pushImageCandidate(message.image, imageUrls, imageUrlSet);
        pushImageCandidate(message.b64_json, imageUrls, imageUrlSet);
        pushImageCandidate(message.data, imageUrls, imageUrlSet);

        const messageImageUrlCandidate =
            isRecord(message.image_url) && typeof message.image_url.url === 'string'
                ? message.image_url.url
                : message.image_url;
        pushImageCandidate(messageImageUrlCandidate, imageUrls, imageUrlSet);

        if (Array.isArray(message.images)) {
            for (const item of message.images) {
                if (!isRecord(item)) {
                    pushImageCandidate(item, imageUrls, imageUrlSet);
                    continue;
                }

                pushImageCandidate(item.url, imageUrls, imageUrlSet);
                pushImageCandidate(item.b64_json, imageUrls, imageUrlSet);
                const imageUrl = isRecord(item.image_url) ? item.image_url.url : item.image_url;
                pushImageCandidate(imageUrl, imageUrls, imageUrlSet);
            }
        }
    }

    const text = textChunks.join('\n\n').trim();
    const markdownImages = imageUrls.map((url, index) => `![Generated image ${index + 1}](${url})`);

    if (text && markdownImages.length > 0) {
        return `${text}\n\n${markdownImages.join('\n\n')}`;
    }

    if (markdownImages.length > 0) {
        return markdownImages.join('\n\n');
    }

    return text || null;
}

async function runChatWithImageChatCompletions(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[]
): Promise<ModelDrivenSearchResult> {
    const completion = await openai.chat.completions.create({
        model,
        messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
        })),
    });

    const content = extractCompletionMessageContent(completion);
    if (!content) {
        throw new Error('Empty response from AI');
    }

    return {
        message: content,
        webSearch: null,
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

async function runChatWithoutTools(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[]
): Promise<ModelDrivenSearchResult> {
    return {
        message: await runChatWithResponsesModel(openai, model, messages),
        webSearch: null,
    };
}

async function runChatWithWebStrategy(
    openai: OpenAI,
    model: string,
    messages: readonly ChatMessage[]
): Promise<ModelDrivenSearchResult> {
    if (isChatCompletionsImageModel(model)) {
        return runChatWithImageChatCompletions(openai, model, messages);
    }

    if (!isNativeWebSearchModel(model)) {
        return runChatWithoutTools(openai, model, messages);
    }

    try {
        return await runChatWithNativeWebSearch(openai, model, messages);
    } catch (error) {
        if (!isUnsupportedWebSearchError(error)) {
            throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn('Model rejected native web_search tool; falling back to plain responses', {
            model,
            error: errorMessage,
        });

        return runChatWithoutTools(openai, model, messages);
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
    const selectedPrimaryModel = isAllowedRuntimePrimaryModel(candidatePrimaryModel)
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
