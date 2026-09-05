import { z } from "zod";

const BaseAnalysisResultSchema = z.object({
  coverage_notices: z.array(z.string()).optional(),
  risk_badge: z.enum(["LOW", "MEDIUM", "HIGH"]),

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
      how: z.string().trim().min(1),
      notice_period_days: z.number().int().nonnegative(),
      penalties: z.array(z.string()),
    }),
  }),

  red_flags: z.array(
    z.object({
      type: z.string(),
      // null when the model didn't supply a value — we don't fabricate a score/level.
      severity: z.number().min(1).max(10).nullable(),
      explanation: z.string(),
      where: z.string().nullable(),
      confidence: z.number().min(0).max(100).nullable(),
    }),
  ),

  normal_in_region: z.array(
    z.object({
      topic: z.string(),
      typical_range: z.string(),
      yours: z.string().nullable(),
      label: z.enum(["typical", "unusual"]),
    }),
  ),

  next_actions: z.object({
    questions_to_ask: z.array(z.string()),
    email_templates: z.array(
      z.object({
        subject: z.string(),
        body: z.string(),
      }),
    ),
  }),

  key_dates: z.array(
    z.object({
      type: z.enum(["RENEWAL", "NOTICE_CUTOFF", "PRICE_REVIEW", "OTHER"]),
      date: z.string(),
      derived_from: z.string().nullable(),
    }),
  ),

  obligations: z.array(z.string()),

  parties: z.array(z.string()),

  disclaimer: z.string(),
});

export type AnalysisResult = z.infer<typeof BaseAnalysisResultSchema>;

const NON_SUBSTANTIVE_VALUES = new Set([
  "",
  "unknown",
  "undetermined",
  "unspecified",
  "not specified",
  "not provided",
  "not available",
  "not found",
  "not applicable",
  "no information provided",
  "cannot determine",
  "n/a",
  "none",
  "none identified",
  "contract analysis",
  "general term",
  "general risk",
  "potential risk identified",
  "contract clarification request",
]);

function isSubstantiveText(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();
  return !NON_SUBSTANTIVE_VALUES.has(normalized);
}

/**
 * Defaults make partial provider output safe to render, but defaults alone are not an analysis.
 * Require at least one concrete observation before the payload can be accepted or persisted.
 * Risk level and the legal-advice disclaimer intentionally do not count as observations.
 */
export function hasSubstantiveAnalysisContent(result: AnalysisResult): boolean {
  const { summary } = result;

  return Boolean(
    result.key_points.some(isSubstantiveText) ||
    isSubstantiveText(summary.what_it_is) ||
    isSubstantiveText(summary.payments.amount) ||
    isSubstantiveText(summary.payments.frequency) ||
    summary.payments.fees.some(isSubstantiveText) ||
    isSubstantiveText(summary.term.start) ||
    isSubstantiveText(summary.term.end) ||
    isSubstantiveText(summary.term.minimum_term) ||
    summary.renewal.auto_renew ||
    isSubstantiveText(summary.renewal.renewal_period) ||
    isSubstantiveText(summary.cancellation.how) ||
    summary.cancellation.notice_period_days > 0 ||
    summary.cancellation.penalties.some(isSubstantiveText) ||
    result.red_flags.some(
      (flag) =>
        isSubstantiveText(flag.type) || isSubstantiveText(flag.explanation),
    ) ||
    result.normal_in_region.some(
      (item) =>
        isSubstantiveText(item.topic) ||
        isSubstantiveText(item.typical_range) ||
        isSubstantiveText(item.yours),
    ) ||
    result.next_actions.questions_to_ask.some(isSubstantiveText) ||
    result.next_actions.email_templates.some(
      (template) =>
        isSubstantiveText(template.subject) || isSubstantiveText(template.body),
    ) ||
    result.key_dates.some(
      (date) =>
        isSubstantiveText(date.date) || isSubstantiveText(date.derived_from),
    ) ||
    result.obligations.some(isSubstantiveText) ||
    result.parties.some(isSubstantiveText),
  );
}

function addSubstantiveContentIssue(
  result: AnalysisResult,
  context: z.RefinementCtx,
): void {
  if (hasSubstantiveAnalysisContent(result)) return;

  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Analysis contains no substantive contract observations",
  });
}

export const AnalysisResultSchema = BaseAnalysisResultSchema.superRefine(
  addSubstantiveContentIssue,
);

export const PartialAnalysisResultSchema = z
  .object({
    risk_badge: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().default("MEDIUM"),
    key_points: z.array(z.string()).optional().default([]),
    summary: z.object({
      what_it_is: z.string().optional().default("Contract analysis"),
      payments: z
        .object({
          amount: z.string().nullable().optional().default(null),
          frequency: z.string().nullable().optional().default(null),
          fees: z.array(z.string()).optional().default([]),
        })
        .optional()
        .default({ amount: null, frequency: null, fees: [] }),
      term: z
        .object({
          start: z.string().nullable().optional().default(null),
          end: z.string().nullable().optional().default(null),
          minimum_term: z.string().nullable().optional().default(null),
        })
        .optional()
        .default({ start: null, end: null, minimum_term: null }),
      renewal: z.object({
        auto_renew: z.boolean(),
        renewal_period: z.string().nullable().optional().default(null),
      }),
      cancellation: z.object({
        how: z.string().trim().min(1),
        notice_period_days: z.number().int().nonnegative(),
        penalties: z.array(z.string()).optional().default([]),
      }),
    }),
    red_flags: z
      .array(
        z.object({
          type: z.string(),
          severity: z
            .number()
            .min(1)
            .max(10)
            .nullable()
            .optional()
            .default(null),
          explanation: z.string(),
          where: z.string().nullable().optional().default(null),
          confidence: z
            .number()
            .min(0)
            .max(100)
            .nullable()
            .optional()
            .default(null),
        }),
      )
      .optional()
      .default([]),
    normal_in_region: z
      .array(
        z.object({
          topic: z.string(),
          typical_range: z.string(),
          yours: z.string().nullable().optional().default(null),
          label: z.enum(["typical", "unusual"]),
        }),
      )
      .optional()
      .default([]),
    next_actions: z
      .object({
        questions_to_ask: z.array(z.string()).optional().default([]),
        email_templates: z
          .array(
            z.object({
              subject: z.string(),
              body: z.string(),
            }),
          )
          .optional()
          .default([]),
      })
      .optional()
      .default({ questions_to_ask: [], email_templates: [] }),
    key_dates: z
      .array(
        z.object({
          type: z.enum(["RENEWAL", "NOTICE_CUTOFF", "PRICE_REVIEW", "OTHER"]),
          date: z.string(),
          derived_from: z.string().nullable().optional().default(null),
        }),
      )
      .optional()
      .default([]),
    obligations: z.array(z.string()).optional().default([]),
    parties: z.array(z.string()).optional().default([]),
    disclaimer: z
      .string()
      .optional()
      .default("This is an AI analysis, not legal advice."),
  })
  .superRefine(addSubstantiveContentIssue);
