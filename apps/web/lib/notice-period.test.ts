import { describe, expect, it } from "vitest";
import { parseStrictJson } from "./analysis";
import type { AnalysisResult } from "./schemas";
import { formatNoticePeriod, normalizeNoticePeriod } from "./notice-period";

describe("uncertain contract terms", () => {
  it("accepts explicit unknowns without converting them to false or zero", () => {
    const result = parseStrictJson<AnalysisResult>(
      JSON.stringify({
        risk_badge: "MEDIUM",
        key_points: ["The agreement requires monthly payment."],
        summary: {
          renewal: { auto_renew: null },
          cancellation: { how: "Not specified", notice_period_days: null },
        },
      }),
    );
    expect(result.summary.renewal.auto_renew).toBeNull();
    expect(result.summary.cancellation.notice_period_days).toBeNull();
    expect(formatNoticePeriod(result.summary.cancellation)).toBe(
      "Not specified",
    );
  });
  it.each([
    "10 business days",
    "2 months",
    "15–30 days",
    "1.5 days",
    "at the end of the term",
  ])("preserves %s without an unsafe conversion", (wording) => {
    const result = parseStrictJson<AnalysisResult>(JSON.stringify({
      risk_badge: "MEDIUM",
      key_points: ["Notice is required before cancellation."],
      summary: {
        renewal: { auto_renew: false },
        cancellation: {
          how: "Notify the supplier in writing",
          notice_period_days: 10,
          notice_period_text: wording,
        },
      },
    }));
    const notice = result.summary.cancellation;
    expect(notice.notice_period_days).toBeNull();
    expect(formatNoticePeriod(notice)).toBe(wording);
  });
  it("keeps old numeric reports readable and preserves an explicit zero", () => {
    expect(formatNoticePeriod({ notice_period_days: 30 })).toBe("30 days");
    expect(normalizeNoticePeriod(0, undefined)?.notice_period_days).toBe(0);
    expect(
      normalizeNoticePeriod(undefined, "30 calendar days")?.notice_period_days,
    ).toBe(30);
    expect(normalizeNoticePeriod(undefined, undefined)).toBeNull();
  });
});
