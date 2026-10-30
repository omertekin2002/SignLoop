import { z } from "zod";
import { MAX_EVIDENCE_QUOTE, SegmentLabelSchema } from "@/lib/source-citations";
import { CLAUSE_CATEGORIES } from "./taxonomy";

export const DURATION_UNITS = [
  "day",
  "business_day",
  "week",
  "month",
  "year",
] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** A duration compared as (number, unit), e.g. {"canon": [10, "business_day"]}. */
const DurationGoldSchema = z.strictObject({
  canon: z.tuple([z.number().int().positive(), z.enum(DURATION_UNITS)]),
});

/**
 * Scored summary fields. An absent key is not scored; null means the contract text sent to the
 * model does not establish the value, so the ideal answer abstains.
 */
const FieldsSchema = z.strictObject({
  "summary.renewal.auto_renew": z.boolean().nullable().optional(),
  "summary.renewal.renewal_period": DurationGoldSchema.nullable().optional(),
  "summary.cancellation.notice_period_text":
    DurationGoldSchema.nullable().optional(),
  "summary.cancellation.notice_period_days": z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional(),
});
export type FieldPath = keyof z.infer<typeof FieldsSchema>;

/** Exact contract text. It must occur exactly once in the contract. */
const GoldSpanSchema = z
  .string()
  .refine((span) => span.trim().length > 0, "Span must not be blank")
  .refine(
    (span) => Array.from(span).length <= MAX_EVIDENCE_QUOTE,
    `Span must be at most ${MAX_EVIDENCE_QUOTE} code points`,
  );

const GoldClauseSchema = z.strictObject({
  category: z.enum(CLAUSE_CATEGORIES),
  /** Required clauses count toward recall; optional ones are acceptable citations only. */
  required: z.boolean(),
  span: GoldSpanSchema,
  /** Asserted when present: "full", or the "section-N" of a long contract the span lies in. */
  segment: SegmentLabelSchema.optional(),
});

export const EvalCaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(1),
    // Other provenance kinds (public corpora, recorded traffic) need a licence and privacy review.
    provenance: z.literal("synthetic/hand-written"),
    contract: z.string().regex(/^contracts\/[a-z0-9-]+\.txt$/),
    context: z
      .array(
        z.strictObject({
          title: z.string().min(1),
          document_type: z.string().min(1),
          file: z.string().regex(/^contracts\/[a-z0-9-]+\.txt$/),
        }),
      )
      .max(8),
    /** Benign contracts must not draw high-severity flags or a HIGH badge. */
    benign: z.boolean().default(false),
    notes: z.string().optional(),
    clauses: z.array(GoldClauseSchema),
    absent: z.array(z.enum(CLAUSE_CATEGORIES)).default([]),
    /**
     * The jurisdiction the governing-law clause names, and the clause, which must be in a sent
     * segment. null means the contract has no such clause, so the ideal answer proposes none.
     * Absent means the proposal is not scored.
     */
    governing_law: z
      .strictObject({ jurisdiction: z.string().min(1), span: GoldSpanSchema })
      .nullable()
      .optional(),
    fields: FieldsSchema,
    key_dates: z
      .array(
        z.strictObject({
          type: z.enum(["RENEWAL", "NOTICE_CUTOFF", "PRICE_REVIEW", "OTHER"]),
          date: z.iso.date(),
          /** Optional dates (e.g. derivable deadlines) are not required but are not unsupported. */
          required: z.boolean().default(true),
        }),
      )
      .default([]),
    parties: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          aliases: z.array(z.string().min(1)).default([]),
        }),
      )
      .default([]),
  })
  .superRefine((value, context) => {
    for (const clause of value.clauses) {
      if (value.absent.includes(clause.category)) {
        context.addIssue({
          code: "custom",
          path: ["absent"],
          message: `${clause.category} is both a gold clause and an absent category`,
        });
      }
    }
  });
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalCaseInput = z.input<typeof EvalCaseSchema>;

const MetricValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null(),
]);

/** A hand-written ideal model output for one case, replayed through the real pipeline. */
export const OracleSchema = z.strictObject({
  case: z.string().min(1),
  note: z.string().optional(),
  /** Metrics where even the ideal answer is imperfect, with the value the pipeline yields. */
  ideal: z.record(z.string(), MetricValueSchema).default({}),
  output: z.record(z.string(), z.unknown()),
});
export type Oracle = z.infer<typeof OracleSchema>;

/** A deliberately bad response: an oracle output with one targeted change. */
export const PerturbationSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  case: z.string().min(1),
  description: z.string().min(1),
  /** RFC 6901 pointers into the oracle output; every target path must already exist. */
  patch: z
    .array(
      z.strictObject({ path: z.string().startsWith("/"), value: z.unknown() }),
    )
    .min(1),
  /** Exactly the case metrics this change may move. */
  targets: z.array(z.string().min(1)).min(1),
});
export type Perturbation = z.infer<typeof PerturbationSchema>;
