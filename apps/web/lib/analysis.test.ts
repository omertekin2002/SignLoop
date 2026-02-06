import { describe, expect, it, vi } from 'vitest';
import { parseStrictJson } from './analysis';
import type { AnalysisResult } from './schemas';

const validPayload: AnalysisResult = {
    risk_badge: 'LOW',
    key_points: ['Clear term', 'Simple payment schedule'],
    summary: {
        what_it_is: 'A basic membership contract',
        payments: { amount: '$50', frequency: 'monthly', fees: [] },
        term: { start: '2026-01-01', end: '2026-12-31', minimum_term: '12 months' },
        renewal: { auto_renew: false, renewal_period: null },
        cancellation: { how: 'Email notice', notice_period_days: 30, penalties: [] },
    },
    red_flags: [],
    normal_in_region: [],
    next_actions: { questions_to_ask: [], email_templates: [] },
    key_dates: [],
    obligations: ['Pay monthly fee'],
    parties: ['Gym', 'Member'],
    disclaimer: 'This is an AI analysis, not legal advice.',
};

describe('parseStrictJson', () => {
    it('parses valid schema-compliant JSON', () => {
        const result = parseStrictJson<AnalysisResult>(JSON.stringify(validPayload));
        expect(result.risk_badge).toBe('LOW');
        expect(result.summary.cancellation.notice_period_days).toBe(30);
    });

    it('recovers malformed JSON and normalizes common model shape/type mistakes', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const malformedPayload = `{
  "risk_badge": "moderate",
  "key_points": "Usage restrictions; Limited cancellation rights",
  "summary": {
    "whatItIs": "A gym membership agreement",
    "payments": { "amount": "", "frequency": "monthly", "fees": "late fee" },
    "term": { "startDate": "2026-01-01", "endDate": "2027-01-01", "minimumTerm": "12 months" },
    "renewal": { "autoRenew": "yes", "renewalPeriod": "12 months" },
    "cancellation": { "method": "email notice", "noticeDays": "30 days", "penalties": "early termination fee" }
  },
  "redFlags": { "type": "Auto renew", "severity": "11", "description": "Renews automatically", "where": "Section 5", "confidence": "120" },
  "normalInRegion": { "topic": "Renewal", "typicalRange": "30-day notice", "yourTerm": "auto-renew", "status": "Atypical" },
  "nextActions": {
    "questionsToAsk": "Can we remove auto-renewal?",
    "emailTemplates": { "subject": "Contract clarification", "message": "Please remove auto-renewal." }
  },
  "keyDates": [{ "kind": "renewal date", "when": "2027-01-01" }],
  "obligations": "Pay on time",
  "parties": "Member and Gym",
  "disclaimer": "This is an AI analysis, not legal advice.",
}`;

        try {
            const result = parseStrictJson<AnalysisResult>(malformedPayload);

            expect(result.risk_badge).toBe('MEDIUM');
            expect(result.summary.renewal.auto_renew).toBe(true);
            expect(result.summary.cancellation.notice_period_days).toBe(30);
            expect(result.red_flags).toHaveLength(1);
            expect(result.red_flags[0]?.severity).toBe(10);
            expect(result.red_flags[0]?.confidence).toBe(100);
            expect(result.normal_in_region[0]?.label).toBe('unusual');
            expect(result.key_dates[0]?.type).toBe('RENEWAL');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('throws a parse error for non-JSON responses', () => {
        expect(() => parseStrictJson<AnalysisResult>('This is not JSON')).toThrow(
            /Failed to parse JSON from model response/i,
        );
    });
});
