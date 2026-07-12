import { describe, expect, it } from "vitest";
import { formatFileSize } from "./utils";

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
