import { z } from 'zod';

export const AnalysisResultSchema = z.object({
    risk_badge: z.enum(['LOW', 'MEDIUM', 'HIGH']),

    key_points: z.array(z.string()),

    summary: z.object({
        what_it_is: z.string(),
        payments: z.object({
            amount: z.string().nullable(),
            frequency: z.string().nullable(),
            fees: z.array(z.string()),
        }),
        term: z.object({
            start: z.string().nullable(),
            end: z.string().nullable(),
            minimum_term: z.string().nullable(),
        }),
        renewal: z.object({
            auto_renew: z.boolean(),
            renewal_period: z.string().nullable(),
        }),
        cancellation: z.object({
            how: z.string(),
            notice_period_days: z.number(),
            penalties: z.array(z.string()),
        }),
    }),

    red_flags: z.array(z.object({
        type: z.string(),
        severity: z.number().min(1).max(10),
        explanation: z.string(),
        where: z.string().nullable(),
        confidence: z.number().min(0).max(100),
    })),

    normal_in_region: z.array(z.object({
        topic: z.string(),
        typical_range: z.string(),
        yours: z.string().nullable(),
        label: z.enum(['typical', 'unusual']),
    })),

    next_actions: z.object({
        questions_to_ask: z.array(z.string()),
        email_templates: z.array(z.object({
            subject: z.string(),
            body: z.string(),
        })),
    }),

    key_dates: z.array(z.object({
        type: z.enum(['RENEWAL', 'NOTICE_CUTOFF', 'PRICE_REVIEW', 'OTHER']),
        date: z.string(),
        derived_from: z.string().nullable(),
    })),

    obligations: z.array(z.string()),

    parties: z.array(z.string()),

    disclaimer: z.string(),
});

export const PartialAnalysisResultSchema = z.object({
    risk_badge: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM'),
    key_points: z.array(z.string()).optional().default([]),
    summary: z.object({
        what_it_is: z.string().optional().default('Contract analysis'),
        payments: z.object({
            amount: z.string().nullable().optional().default(null),
            frequency: z.string().nullable().optional().default(null),
            fees: z.array(z.string()).optional().default([]),
        }).optional().default({ amount: null, frequency: null, fees: [] }),
        term: z.object({
            start: z.string().nullable().optional().default(null),
            end: z.string().nullable().optional().default(null),
            minimum_term: z.string().nullable().optional().default(null),
        }).optional().default({ start: null, end: null, minimum_term: null }),
        renewal: z.object({
            auto_renew: z.boolean().optional().default(false),
            renewal_period: z.string().nullable().optional().default(null),
        }).optional().default({ auto_renew: false, renewal_period: null }),
        cancellation: z.object({
            how: z.string().optional().default('Not specified'),
            notice_period_days: z.number().optional().default(0),
            penalties: z.array(z.string()).optional().default([]),
        }).optional().default({ how: 'Not specified', notice_period_days: 0, penalties: [] }),
    }).optional().default({ 
        what_it_is: 'Contract analysis',
        payments: { amount: null, frequency: null, fees: [] },
        term: { start: null, end: null, minimum_term: null },
        renewal: { auto_renew: false, renewal_period: null },
        cancellation: { how: 'Not specified', notice_period_days: 0, penalties: [] }
    }),
    red_flags: z.array(z.object({
        type: z.string(),
        severity: z.number().min(1).max(10),
        explanation: z.string(),
        where: z.string().nullable().optional().default(null),
        confidence: z.number().min(0).max(100).optional().default(50),
    })).optional().default([]),
    normal_in_region: z.array(z.object({
        topic: z.string(),
        typical_range: z.string(),
        yours: z.string().nullable().optional().default(null),
        label: z.enum(['typical', 'unusual']),
    })).optional().default([]),
    next_actions: z.object({
        questions_to_ask: z.array(z.string()).optional().default([]),
        email_templates: z.array(z.object({
            subject: z.string(),
            body: z.string(),
        })).optional().default([]),
    }).optional().default({ questions_to_ask: [], email_templates: [] }),
    key_dates: z.array(z.object({
        type: z.enum(['RENEWAL', 'NOTICE_CUTOFF', 'PRICE_REVIEW', 'OTHER']),
        date: z.string(),
        derived_from: z.string().nullable().optional().default(null),
    })).optional().default([]),
    obligations: z.array(z.string()).optional().default([]),
    parties: z.array(z.string()).optional().default([]),
    disclaimer: z.string().optional().default('This is an AI analysis, not legal advice.'),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
