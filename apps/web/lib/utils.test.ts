import { describe, expect, it } from "vitest";
import { formatDate, formatFileSize } from "./utils";

describe("formatFileSize", () => {
  it("keeps byte-sized and kilobyte-sized files legible", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("retains megabyte precision and handles invalid values safely", () => {
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.50 MB");
    expect(formatFileSize(Number.NaN)).toBe("0 B");
    expect(formatFileSize(-1)).toBe("0 B");
  });
});

describe("formatDate", () => {
  // Explicit zones keep these assertions independent of the machine running the suite. They span
  // UTC-11 to UTC+14, where a single instant falls on three different calendar days.
  const zones = [
    "UTC",
    "America/New_York",
    "Pacific/Pago_Pago",
    "Pacific/Kiritimati",
  ];

  it.each(zones)("renders ISO calendar dates as written in %s", (zone) => {
    expect(formatDate("2026-12-01", "MMM d, yyyy", "", zone)).toBe(
      "Dec 1, 2026",
    );
    expect(formatDate("2026-01-01", "MMMM d, yyyy", "", zone)).toBe(
      "January 1, 2026",
    );
    expect(formatDate("2028-02-29", "MMM d, yyyy HH:mm", "", zone)).toBe(
      "Feb 29, 2028 00:00",
    );
    expect(formatDate(" 2026-12-31 ", "MMM d, yyyy", "", zone)).toBe(
      "Dec 31, 2026",
    );
    expect(formatDate("2026-12", "MMM d, yyyy", "", zone)).toBe("Dec 1, 2026");
    expect(formatDate("2026", "MMM d, yyyy", "", zone)).toBe("Jan 1, 2026");
  });

  it("converts timestamps to the requested zone", () => {
    const instant = "2026-12-01T10:30:00.000Z";
    const format = (zone: string) =>
      formatDate(instant, "MMM d, yyyy HH:mm", "", zone);
    expect(format("UTC")).toBe("Dec 1, 2026 10:30");
    expect(format("America/New_York")).toBe("Dec 1, 2026 05:30");
    expect(format("Pacific/Pago_Pago")).toBe("Nov 30, 2026 23:30");
    expect(format("Pacific/Kiritimati")).toBe("Dec 2, 2026 00:30");
    expect(
      formatDate(new Date(instant), "MMM d, HH:mm", "", "Pacific/Kiritimati"),
    ).toBe("Dec 2, 00:30");
    // The same moment as a timestamp is still an instant, unlike the bare calendar date above.
    expect(
      formatDate("2026-12-01T00:00:00Z", "MMM d, yyyy", "", "America/New_York"),
    ).toBe("Nov 30, 2026");
  });

  it("uses the runtime's local zone by default, except for calendar dates", () => {
    const instant = new Date("2026-12-01T10:30:00.000Z");
    const pad = (value: number) => String(value).padStart(2, "0");
    expect(formatDate(instant.toISOString(), "d HH:mm yyyy")).toBe(
      `${instant.getDate()} ${pad(instant.getHours())}:${pad(instant.getMinutes())} ${instant.getFullYear()}`,
    );
    expect(formatDate("2026-12-01", "MMM d, yyyy")).toBe("Dec 1, 2026");
  });

  it("returns the fallback for missing, descriptive, and impossible dates", () => {
    expect(formatDate(null, "MMM d, yyyy", "Unknown date")).toBe(
      "Unknown date",
    );
    expect(formatDate(undefined, "MMM d, HH:mm")).toBe("");
    expect(formatDate("Unknown", "MMM d, yyyy", "Unknown")).toBe("Unknown");
    expect(
      formatDate(
        "30 days after signing",
        "MMM d, yyyy",
        "30 days after signing",
      ),
    ).toBe("30 days after signing");
    expect(formatDate("2026-02-30", "MMM d, yyyy", "invalid")).toBe("invalid");
    expect(formatDate("2026-13-01", "MMM d, yyyy", "invalid")).toBe("invalid");
    expect(formatDate("2026-00", "MMM d, yyyy", "invalid")).toBe("invalid");
  });
});
