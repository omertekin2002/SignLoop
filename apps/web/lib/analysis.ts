import OpenAI from 'openai';
import { AnalysisResultSchema, PartialAnalysisResultSchema, AnalysisResult } from '@/lib/schemas';
import { isUsablePrimaryModel } from '@/lib/model-settings';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS = [
    'google/gemma-4-31b-it:free',
    'openai/gpt-oss-120b:free',
    'openrouter/free',
];
const PRIMARY_LLM_BASE_URL =
    process.env.PRIMARY_LLM_BASE_URL || 'https://efficient-sightlessly-ouida.ngrok-free.dev/v1';
const PRIMARY_LLM_MODEL = process.env.PRIMARY_LLM_MODEL || 'gemini-3-flash';
const PRIMARY_LLM_API_KEY = process.env.PRIMARY_LLM_API_KEY;
const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const APP_NAME = 'SignLoop';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    return value as JsonRecord;
}

function pickFirst(record: JsonRecord, keys: string[]): unknown {
    for (const key of keys) {
        if (key in record) return record[key];
    }
    return undefined;
}

function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
}

function toStringOrNull(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return null;
}

function toNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const numericMatch = value.match(/-?\d+(\.\d+)?/);
        if (numericMatch) {
            const parsed = Number(numericMatch[0]);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return fallback;
}

function toBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1', 'on', 'enabled'].includes(normalized)) return true;
        if (['false', 'no', 'n', '0', 'off', 'disabled'].includes(normalized)) return false;
    }
    return fallback;
}

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function toStringArray(value: unknown): string[] {
    if (typeof value === 'string') {
        const cleaned = value
            .replace(/\r/g, '\n')
            .replace(/^[\s*-]+/gm, '')
            .trim();
        if (!cleaned) return [];
        const parts = cleaned
            .split(/\n|•|;|,(?=\s)/g)
            .map((item) => item.trim())
            .filter(Boolean);
        return parts.length > 0 ? parts : [cleaned];
    }

    return toArray(value)
        .map((item) => toStringOrNull(item))
        .filter((item): item is string => Boolean(item));
}

function normalizeRiskBadge(value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' {
    const normalized = toStringOrNull(value)?.toLowerCase() || '';
    if (normalized.includes('high')) return 'HIGH';
    if (normalized.includes('low')) return 'LOW';
    if (normalized.includes('medium') || normalized.includes('moderate') || normalized.includes('mid')) {
        return 'MEDIUM';
    }
    return 'MEDIUM';
}

function normalizeRegionLabel(value: unknown): 'typical' | 'unusual' {
    const normalized = toStringOrNull(value)?.toLowerCase() || '';
    if (normalized.includes('unusual') || normalized.includes('atypical') || normalized.includes('non-standard')) {
        return 'unusual';
    }
    return 'typical';
}

function normalizeDateType(value: unknown): 'RENEWAL' | 'NOTICE_CUTOFF' | 'PRICE_REVIEW' | 'OTHER' {
    const normalized = toStringOrNull(value)?.toLowerCase() || '';
    if (normalized.includes('renew')) return 'RENEWAL';
    if (normalized.includes('notice')) return 'NOTICE_CUTOFF';
    if (normalized.includes('price') || normalized.includes('fee') || normalized.includes('rate')) return 'PRICE_REVIEW';
    return 'OTHER';
}

function formatValidationIssues(
    issues: Array<{ path: PropertyKey[]; message: string }>
): string[] {
    return issues.map((issue) => {
        const path = issue.path.length ? issue.path.map(String).join('.') : '(root)';
        return `${path}: ${issue.message}`;
    });
}

function normalizeAnalysisPayload(parsed: unknown): AnalysisResult {
    const source = asRecord(parsed) ?? {};
    const summary = asRecord(pickFirst(source, ['summary'])) ?? {};
    const payments = asRecord(pickFirst(summary, ['payments', 'payment'])) ?? {};
    const term = asRecord(pickFirst(summary, ['term'])) ?? {};
    const renewal = asRecord(pickFirst(summary, ['renewal'])) ?? {};
    const cancellation = asRecord(pickFirst(summary, ['cancellation'])) ?? {};

    const redFlags = toArray(pickFirst(source, ['red_flags', 'redFlags', 'risks', 'risk_flags']))
        .map((item) => {
            const record = asRecord(item);
            if (!record) {
                const text = toStringOrNull(item);
                if (!text) return null;
                return {
                    type: 'General risk',
                    severity: 5,
                    explanation: text,
                    where: null,
                    confidence: 50,
                };
            }

            const explanation = toStringOrNull(
                pickFirst(record, ['explanation', 'details', 'description', 'why'])
            );
            return {
                type: toStringOrNull(pickFirst(record, ['type', 'category', 'name'])) || 'General risk',
                severity: clamp(
                    Math.round(toNumber(pickFirst(record, ['severity', 'score', 'risk_score']), 5)),
                    1,
                    10
                ),
                explanation: explanation || 'Potential risk identified.',
                where: toStringOrNull(pickFirst(record, ['where', 'location', 'clause'])),
                confidence: clamp(
                    Math.round(toNumber(pickFirst(record, ['confidence', 'certainty']), 50)),
                    0,
                    100
                ),
            };
        })
        .filter((item): item is AnalysisResult['red_flags'][number] => Boolean(item));

    const normalInRegion = toArray(
        pickFirst(source, ['normal_in_region', 'normalInRegion', 'regional_norms'])
    )
        .map((item) => {
            const record = asRecord(item);
            if (!record) {
                const text = toStringOrNull(item);
                if (!text) return null;
                return {
                    topic: text,
                    typical_range: 'Not specified',
                    yours: null,
                    label: 'typical' as const,
                };
            }

            return {
                topic: toStringOrNull(pickFirst(record, ['topic', 'item', 'clause'])) || 'General term',
                typical_range:
                    toStringOrNull(pickFirst(record, ['typical_range', 'typicalRange', 'typical'])) ||
                    'Not specified',
                yours: toStringOrNull(pickFirst(record, ['yours', 'your_term', 'yourTerm'])),
                label: normalizeRegionLabel(pickFirst(record, ['label', 'status'])),
            };
        })
        .filter((item): item is AnalysisResult['normal_in_region'][number] => Boolean(item));

    const nextActions = asRecord(pickFirst(source, ['next_actions', 'nextActions'])) ?? {};

    const emailTemplates = toArray(pickFirst(nextActions, ['email_templates', 'emailTemplates']))
        .map((item) => {
            const record = asRecord(item);
            if (!record) {
                const text = toStringOrNull(item);
                if (!text) return null;
                return {
                    subject: 'Contract clarification request',
                    body: text,
                };
            }
            return {
                subject: toStringOrNull(pickFirst(record, ['subject', 'title'])) || 'Contract clarification request',
                body: toStringOrNull(pickFirst(record, ['body', 'message', 'content'])) || '',
            };
        })
        .filter((item): item is AnalysisResult['next_actions']['email_templates'][number] => Boolean(item));

    const keyDates = toArray(pickFirst(source, ['key_dates', 'keyDates', 'dates']))
        .map((item) => {
            const record = asRecord(item);
            if (!record) {
                const text = toStringOrNull(item);
                if (!text) return null;
                return {
                    type: 'OTHER' as const,
                    date: text,
                    derived_from: null,
                };
            }

            return {
                type: normalizeDateType(pickFirst(record, ['type', 'kind', 'category'])),
                date: toStringOrNull(pickFirst(record, ['date', 'when', 'deadline'])) || 'Unknown',
                derived_from: toStringOrNull(pickFirst(record, ['derived_from', 'source', 'basis'])),
            };
        })
        .filter((item): item is AnalysisResult['key_dates'][number] => Boolean(item));

    return {
        risk_badge: normalizeRiskBadge(pickFirst(source, ['risk_badge', 'riskBadge', 'risk', 'risk_level'])),
        key_points: toStringArray(pickFirst(source, ['key_points', 'keyPoints', 'highlights'])),
        summary: {
            what_it_is:
                toStringOrNull(pickFirst(summary, ['what_it_is', 'whatItIs', 'overview'])) || 'Contract analysis',
            payments: {
                amount: toStringOrNull(pickFirst(payments, ['amount', 'payment_amount', 'price'])),
                frequency: toStringOrNull(pickFirst(payments, ['frequency', 'schedule', 'cadence'])),
                fees: toStringArray(pickFirst(payments, ['fees', 'extra_fees', 'additional_fees'])),
            },
            term: {
                start: toStringOrNull(pickFirst(term, ['start', 'start_date', 'startDate'])),
                end: toStringOrNull(pickFirst(term, ['end', 'end_date', 'endDate'])),
                minimum_term: toStringOrNull(pickFirst(term, ['minimum_term', 'minimumTerm', 'minimum'])),
            },
            renewal: {
                auto_renew: toBoolean(pickFirst(renewal, ['auto_renew', 'autoRenew']), false),
                renewal_period: toStringOrNull(pickFirst(renewal, ['renewal_period', 'renewalPeriod', 'period'])),
            },
            cancellation: {
                how: toStringOrNull(pickFirst(cancellation, ['how', 'method', 'process'])) || 'Not specified',
                notice_period_days: Math.max(
                    0,
                    Math.round(toNumber(pickFirst(cancellation, ['notice_period_days', 'noticeDays', 'notice_period']), 0))
                ),
                penalties: toStringArray(pickFirst(cancellation, ['penalties', 'fees', 'charges'])),
            },
        },
        red_flags: redFlags,
        normal_in_region: normalInRegion,
        next_actions: {
            questions_to_ask: toStringArray(pickFirst(nextActions, ['questions_to_ask', 'questionsToAsk'])),
            email_templates: emailTemplates,
        },
        key_dates: keyDates,
        obligations: toStringArray(pickFirst(source, ['obligations', 'duties'])),
        parties: toStringArray(pickFirst(source, ['parties', 'entities'])),
        disclaimer:
            toStringOrNull(pickFirst(source, ['disclaimer'])) || 'This is an AI analysis, not legal advice.',
    };
}

function stripCodeFences(value: string): string {
    return value
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function removeTrailingCommas(value: string): string {
    return value.replace(/,\s*([}\]])/g, '$1');
}

function extractBalancedJsonObject(value: string): string | null {
    const start = value.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < value.length; i += 1) {
        const ch = value[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            depth += 1;
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return value.slice(start, i + 1);
            }
        }
    }

    return null;
}

function parseModelJson(content: string): unknown {
    const trimmed = content.trim();
    const withoutFences = stripCodeFences(trimmed);
    const balancedCandidate = extractBalancedJsonObject(withoutFences);
    const candidates = [
        trimmed,
        withoutFences,
        balancedCandidate ?? '',
        removeTrailingCommas(withoutFences),
        balancedCandidate ? removeTrailingCommas(balancedCandidate) : '',
    ].filter((candidate): candidate is string => Boolean(candidate));

    const uniqueCandidates = Array.from(new Set(candidates));
    let lastError: Error | null = null;

    for (const candidate of uniqueCandidates) {
        try {
            return JSON.parse(candidate);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }

    throw new Error(`Failed to parse JSON from model response: ${lastError?.message ?? 'Unknown parse error'}`);
}

function isLikelyUnsupportedJsonModeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(response_format|text\.format|json_object|json mode|unsupported|not support)/i.test(message);
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

async function createResponsesPreferringJson(
    openai: OpenAI,
    model: string,
    instructions: string,
    input: string,
) {
    try {
        return await openai.responses.create({
            model,
            instructions,
            input,
            text: { format: { type: 'json_object' } },
        });
    } catch (error) {
        if (!isLikelyUnsupportedJsonModeError(error)) {
            throw error;
        }

        console.warn('Model/provider rejected text.format=json_object on Responses API, retrying without it');
        return await openai.responses.create({
            model,
            instructions,
            input,
        });
    }
}

async function repairJsonWithResponsesModel(
    openai: OpenAI,
    model: string,
    malformedContent: string
): Promise<string> {
    const repairPrompt = `
You are a JSON repair tool.
Return ONLY a valid JSON object.
Do not include markdown or explanations.

Required top-level keys:
["risk_badge","key_points","summary","red_flags","normal_in_region","next_actions","key_dates","obligations","parties","disclaimer"]

Enum constraints:
- risk_badge: LOW | MEDIUM | HIGH
- normal_in_region[].label: typical | unusual
- key_dates[].type: RENEWAL | NOTICE_CUTOFF | PRICE_REVIEW | OTHER

Type constraints:
- severity, confidence, and notice_period_days must be numbers.
- nullable text fields should be null if unknown.

Repair this malformed JSON-like input:
${malformedContent.slice(0, 12000)}
    `;

    const response = await createResponsesPreferringJson(
        openai,
        model,
        'You fix malformed JSON and output only valid JSON.',
        repairPrompt,
    );

    const repairedContent = extractResponseOutputText(response);
    if (!repairedContent) {
        throw new Error('Empty response from AI during JSON repair');
    }
    return repairedContent;
}

async function runAnalysisWithResponsesModel(
    openai: OpenAI,
    model: string,
    prompt: string,
): Promise<AnalysisResult> {
    const response = await createResponsesPreferringJson(
        openai,
        model,
        'Return only valid JSON with the exact required keys.',
        prompt,
    );

    const content = extractResponseOutputText(response);
    if (!content) {
        throw new Error('Empty response from AI');
    }

    try {
        return parseStrictJson<AnalysisResult>(content);
    } catch (initialError) {
        const initialMessage =
            initialError instanceof Error ? initialError.message : 'Unknown parse/validation error';
        console.warn('Primary analysis response failed parse/validation; attempting repair pass', {
            model,
            initialMessage,
        });

        const repairedContent = await repairJsonWithResponsesModel(openai, model, content);
        try {
            return parseStrictJson<AnalysisResult>(repairedContent);
        } catch (repairError) {
            const repairMessage =
                repairError instanceof Error ? repairError.message : 'Unknown repair parse/validation error';
            throw new Error(
                `LLM response invalid after repair attempt. Initial error: ${initialMessage}. Repair error: ${repairMessage}`
            );
        }
    }
}

export function parseStrictJson<T>(content: string): T {
    const parsed = parseModelJson(content);

    const strictResult = AnalysisResultSchema.safeParse(parsed);
    if (strictResult.success) {
        return strictResult.data as T;
    }

    const lenientResult = PartialAnalysisResultSchema.safeParse(parsed);
    if (lenientResult.success) {
        return lenientResult.data as T;
    }

    const normalizedParsed = normalizeAnalysisPayload(parsed);
    const normalizedStrictResult = AnalysisResultSchema.safeParse(normalizedParsed);
    if (normalizedStrictResult.success) {
        console.warn('LLM response required normalization before passing strict validation', {
            strictIssues: formatValidationIssues(strictResult.error.issues).slice(0, 10),
            lenientIssues: formatValidationIssues(lenientResult.error.issues).slice(0, 10),
        });
        return normalizedStrictResult.data as T;
    }

    const normalizedLenientResult = PartialAnalysisResultSchema.safeParse(normalizedParsed);
    if (normalizedLenientResult.success) {
        console.warn('LLM response required normalization before passing lenient validation', {
            strictIssues: formatValidationIssues(strictResult.error.issues).slice(0, 10),
            lenientIssues: formatValidationIssues(lenientResult.error.issues).slice(0, 10),
        });
        return normalizedLenientResult.data as T;
    }

    const strictIssues = formatValidationIssues(strictResult.error.issues);
    const lenientIssues = formatValidationIssues(lenientResult.error.issues);
    const normalizedStrictIssues = formatValidationIssues(normalizedStrictResult.error.issues);
    const normalizedLenientIssues = formatValidationIssues(normalizedLenientResult.error.issues);
    const firstIssue =
        normalizedStrictIssues[0] ||
        normalizedLenientIssues[0] ||
        lenientIssues[0] ||
        strictIssues[0] ||
        'Unknown schema mismatch';

    console.error('LLM response failed validation', {
        strictIssues,
        lenientIssues,
        normalizedStrictIssues,
        normalizedLenientIssues,
    });

    throw new Error(`LLM response failed validation: ${firstIssue}`);
}

export async function analyzeText(
    text: string,
    metadata?: { contractType?: string; region?: string },
    options?: { primaryModel?: string | null }
): Promise<{ result: AnalysisResult; provider: string; model: string }> {
    const prompt = `
You are an expert legal contract analyst.
Analyze the contract and return ONLY a valid JSON object.
Do not include markdown, code fences, comments, or extra text.

Contract Metadata:
- Type: ${metadata?.contractType || 'Unknown'}
- Region: ${metadata?.region || 'Unknown'}

Required JSON rules:
- Use these exact keys and nested structure.
- "risk_badge" must be exactly one of: "LOW", "MEDIUM", "HIGH".
- "normal_in_region[].label" must be exactly "typical" or "unusual".
- "key_dates[].type" must be exactly one of: "RENEWAL", "NOTICE_CUTOFF", "PRICE_REVIEW", "OTHER".
- "notice_period_days", "severity", and "confidence" must be numbers.
- Use null (not empty string) for unknown nullable string fields.

Expected shape:
{
  "risk_badge": "MEDIUM",
  "key_points": ["..."],
  "summary": {
    "what_it_is": "...",
    "payments": { "amount": null, "frequency": null, "fees": [] },
    "term": { "start": null, "end": null, "minimum_term": null },
    "renewal": { "auto_renew": false, "renewal_period": null },
    "cancellation": { "how": "...", "notice_period_days": 0, "penalties": [] }
  },
  "red_flags": [{ "type": "...", "severity": 5, "explanation": "...", "where": null, "confidence": 50 }],
  "normal_in_region": [{ "topic": "...", "typical_range": "...", "yours": null, "label": "typical" }],
  "next_actions": {
    "questions_to_ask": ["..."],
    "email_templates": [{ "subject": "...", "body": "..." }]
  },
  "key_dates": [{ "type": "OTHER", "date": "YYYY-MM-DD or description", "derived_from": null }],
  "obligations": ["..."],
  "parties": ["..."],
  "disclaimer": "This is an AI analysis, not legal advice."
}

Analysis should be detailed but concise. Identify high-risk clauses specific to the contract type and region.

Contract Text:
${text.substring(0, 15000)} ... (truncated if too long)
        `;

    const candidatePrimaryModel =
        typeof options?.primaryModel === 'string' && options.primaryModel.trim()
            ? options.primaryModel.trim()
            : PRIMARY_LLM_MODEL;
    const selectedPrimaryModel = isUsablePrimaryModel(candidatePrimaryModel)
        ? candidatePrimaryModel
        : PRIMARY_LLM_MODEL;

    try {
        const primaryClient = createOpenAiCompatibleClient(PRIMARY_LLM_BASE_URL, PRIMARY_LLM_API_KEY);
        const primaryResult = await runAnalysisWithResponsesModel(primaryClient, selectedPrimaryModel, prompt);
        return { result: primaryResult, provider: 'ngrok-openai-compatible', model: selectedPrimaryModel };
    } catch (primaryError) {
        const primaryErrorMessage =
            primaryError instanceof Error ? primaryError.message : String(primaryError);
        console.warn('Primary ngrok LLM call failed, falling back to OpenRouter', {
            baseURL: PRIMARY_LLM_BASE_URL,
            model: selectedPrimaryModel,
            error: primaryErrorMessage,
        });

        if (!OPENROUTER_API_KEY) {
            throw new Error(
                `Primary endpoint failed and OpenRouter fallback is not configured. Primary error: ${primaryErrorMessage}`
            );
        }

        const fallbackClient = createOpenAiCompatibleClient(OPENROUTER_BASE_URL, OPENROUTER_API_KEY);
        const fallbackModels = OPENROUTER_MODELS;
        const fallbackFailures: string[] = [];

        for (const fallbackModel of fallbackModels) {
            try {
                const fallbackResult = await runAnalysisWithResponsesModel(fallbackClient, fallbackModel, prompt);
                if (fallbackModel !== fallbackModels[0]) {
                    console.warn('OpenRouter fallback model succeeded after earlier model failed', {
                        firstFallbackModel: fallbackModels[0],
                        successfulFallbackModel: fallbackModel,
                    });
                }
                return { result: fallbackResult, provider: 'openrouter', model: fallbackModel };
            } catch (fallbackError) {
                const fallbackErrorMessage =
                    fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                fallbackFailures.push(`${fallbackModel}: ${fallbackErrorMessage}`);
                console.warn('OpenRouter fallback model failed', {
                    model: fallbackModel,
                    error: fallbackErrorMessage,
                });
            }
        }

        throw new Error(
            `Primary endpoint failed (${primaryErrorMessage}) and OpenRouter fallback failed (${fallbackFailures.join(
                ' | '
            )})`
        );
    }
}
