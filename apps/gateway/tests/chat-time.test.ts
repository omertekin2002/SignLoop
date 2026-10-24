import { describe, expect, it } from "vitest";
import { buildAuthoritativeUtcTimeContext } from "../src/pipeline/chat-time";

describe("buildAuthoritativeUtcTimeContext", () => {
  it("injects an authoritative UTC timestamp and calendar-date comparison rules", () => {
    const result = buildAuthoritativeUtcTimeContext(
      new Date("2026-07-22T08:17:30.123Z"),
    );

    expect(result).toContain("Current UTC timestamp: 2026-07-22T08:17:30.123Z");
    expect(result).toContain("Current UTC calendar date: 2026-07-22");
    expect(result).toContain("dates before 2026-07-22 are in the past");
    expect(result).toContain("2026-07-22 is today");
    expect(result).toContain("dates after 2026-07-22 are in the future");
  });
});
