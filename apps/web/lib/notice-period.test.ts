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

function parseCancellation(cancellation: Record<string, unknown>) {
  return parseStrictJson<AnalysisResult>(JSON.stringify({
    risk_badge: "MEDIUM",
    key_points: ["Notice is required before cancellation."],
    summary: {
      renewal: { auto_renew: true },
      cancellation: { how: "Notify the supplier in writing", ...cancellation },
    },
  })).summary.cancellation;
}

describe("notice period conflicts and legacy aliases", () => {
  it.each(["30", "0", " 0030 "])(
    "treats the numeric day string %j as a count with units",
    (value) => {
      const days = Number(value);
      expect(normalizeNoticePeriod(value, undefined)).toEqual({
        notice_period_days: days,
        notice_period_text: null,
      });
      const notice = parseCancellation({ notice_period_days: value });
      expect(formatNoticePeriod(notice)).toBe(`${days} days`);
    },
  );

  it.each(["10 business days", "30 calendar days", "2 months"])(
    "preserves units in the day field's wording %j",
    (wording) => {
      const notice = parseCancellation({ notice_period_days: wording });
      expect(notice.notice_period_text).toBe(wording);
      expect(formatNoticePeriod(notice)).toBe(wording);
    },
  );

  it("normalizes placeholders as unknowns that never hide an explicit count", () => {
    expect(normalizeNoticePeriod(30, "Not specified")).toEqual({
      notice_period_days: 30,
      notice_period_text: null,
    });
    expect(normalizeNoticePeriod(null, "Unknown")).toEqual({
      notice_period_days: null,
      notice_period_text: null,
    });
    expect(normalizeNoticePeriod(undefined, "N/A")).toEqual({
      notice_period_days: null,
      notice_period_text: null,
    });
    expect(normalizeNoticePeriod("not specified", undefined)).toEqual({
      notice_period_days: null,
      notice_period_text: null,
    });
    expect(normalizeNoticePeriod(30.5, "Not specified")).toBeNull();
    expect(normalizeNoticePeriod(-1, null)).toBeNull();
    expect(normalizeNoticePeriod(undefined, "")).toBeNull();
    expect(normalizeNoticePeriod(30, "2 months")).toEqual({
      notice_period_days: null,
      notice_period_text: "2 months",
    });
  });

  it("renders an explicit count rather than a stored placeholder", () => {
    expect(
      formatNoticePeriod({ notice_period_days: 30, notice_period_text: "Not specified" }),
    ).toBe("30 days");
    expect(
      formatNoticePeriod({ notice_period_days: null, notice_period_text: "Unknown" }),
    ).toBe("Not specified");
  });

  it("accepts the numeric legacy notice_period alias as a day count", () => {
    expect(parseCancellation({ notice_period: 30 })).toMatchObject({
      notice_period_days: 30,
      notice_period_text: null,
    });
    expect(parseCancellation({ notice_period: 0 }).notice_period_days).toBe(0);
  });

  it("keeps legacy notice_period wording authoritative", () => {
    expect(parseCancellation({ notice_period: "10 business days" })).toMatchObject({
      notice_period_days: null,
      notice_period_text: "10 business days",
    });
    expect(
      parseCancellation({ notice_period: 30, notice_period_text: "thirty days" }),
    ).toMatchObject({ notice_period_days: null, notice_period_text: "thirty days" });
  });

  it("prefers the canonical day field over the legacy alias", () => {
    const notice = parseCancellation({ notice_period_days: null, notice_period: 30 });
    expect(notice.notice_period_days).toBeNull();
    expect(formatNoticePeriod(notice)).toBe("Not specified");
  });

  it("keeps an explicit day count when the wording is only a placeholder", () => {
    expect(
      parseCancellation({ notice_period_days: 30, notice_period_text: "Not specified" }),
    ).toMatchObject({ notice_period_days: 30, notice_period_text: null });
  });

  it("keeps explicit unknowns null", () => {
    expect(
      parseCancellation({ notice_period_days: null, notice_period_text: "Not specified" })
        .notice_period_days,
    ).toBeNull();
    expect(parseCancellation({ notice_period: null })).toMatchObject({
      notice_period_days: null,
      notice_period_text: null,
    });
  });

  it.each([30.5, -5])(
    "rejects an unusable legacy day count %s without wording",
    (value) => {
      expect(() => parseCancellation({ notice_period: value })).toThrow(
        /omitted or unusable/,
      );
      expect(() =>
        parseCancellation({ notice_period: value, notice_period_text: "Not specified" }),
      ).toThrow(/omitted or unusable/);
    },
  );
});
