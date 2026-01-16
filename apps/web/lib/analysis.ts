import OpenAI from 'openai';
import { AnalysisResultSchema, PartialAnalysisResultSchema, AnalysisResult } from '@/lib/schemas';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const APP_NAME = 'SignLoop';

function parseStrictJson<T>(content: string): T {
    const trimmed = content.trim();
    let parsed: unknown;

    try {
        parsed = JSON.parse(trimmed);
    } catch {
        const withoutFences = trimmed
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        try {
            parsed = JSON.parse(withoutFences);
        } catch {
            const firstBrace = withoutFences.indexOf('{');
            const lastBrace = withoutFences.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                const slice = withoutFences.slice(firstBrace, lastBrace + 1);
                parsed = JSON.parse(slice);
            } else {
                throw new Error('Failed to parse JSON from model response');
            }
        }
    }

    const strictResult = AnalysisResultSchema.safeParse(parsed);
    if (strictResult.success) {
        return strictResult.data as T;
    }

    const lenientResult = PartialAnalysisResultSchema.safeParse(parsed);
    if (lenientResult.success) {
        return lenientResult.data as T;
    }

    throw new Error('LLM response failed validation');
}

export async function analyzeText(text: string, metadata?: any): Promise<{ result: AnalysisResult; provider: string; model: string }> {
    if (!OPENROUTER_API_KEY) {
        throw new Error('OpenRouter API Key not configured');
    }

    const openai = new OpenAI({
        apiKey: OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders: {
            'HTTP-Referer': SITE_URL,
            'X-Title': APP_NAME,
        },
    });

    const prompt = `
        You are an expert legal contract analyst. Analyze the following contract text and provide a risk assessment and summary.
        
        Contract Metadata:
        Type: ${metadata?.contractType || 'Unknown'}
        Region: ${metadata?.region || 'Unknown'}
        
        Output must be strict JSON matching this structure:
        {
            "risk_badge": "LOW" | "MEDIUM" | "HIGH",
            "key_points": ["string"],
            "summary": {
                "what_it_is": "string",
                "payments": { "amount": "string|null", "frequency": "string|null", "fees": ["string"] },
                "term": { "start": "string|null", "end": "string|null", "minimum_term": "string|null" },
                "renewal": { "auto_renew": boolean, "renewal_period": "string|null" },
                "cancellation": { "how": "string", "notice_period_days": number, "penalties": ["string"] }
            },
            "red_flags": [{ "type": "string", "severity": number (1-10), "explanation": "string", "where": "string|null", "confidence": number (0-100) }],
            "normal_in_region": [{ "topic": "string", "typical_range": "string", "yours": "string|null", "label": "typical" | "unusual" }],
            "next_actions": {
                "questions_to_ask": ["string"],
                "email_templates": [{ "subject": "string", "body": "string" }]
            },
            "key_dates": [{ "type": "RENEWAL" | "NOTICE_CUTOFF" | "PRICE_REVIEW" | "OTHER", "date": "string (ISO)", "derived_from": "string|null" }],
            "disclaimer": "This is an AI analysis, not legal advice."
        }

        Analysis should be detailed but concise. Identify high risk clauses specifically for the region/type.

        Contract Text:
        ${text.substring(0, 15000)} ... (truncated if too long)
        `;

    const model = process.env.OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';
    const completion = await openai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: model,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
        throw new Error('Empty response from AI');
    }

    const result = parseStrictJson<AnalysisResult>(content);
    return { result, provider: 'openrouter', model };
}
