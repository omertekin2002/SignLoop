import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "@/lib/contract-search";

describe("escapeLikePattern", () => {
  it("leaves ordinary text unchanged", () => {
    expect(escapeLikePattern("Office Lease 2026")).toBe("Office Lease 2026");
  });

  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLikePattern("50%_off\\v2")).toBe("50\\%\\_off\\\\v2");
  });
});
