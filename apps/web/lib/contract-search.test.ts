import { describe, expect, it } from "vitest";
import {
  capContractSearch,
  escapeLikePattern,
  MAX_CONTRACT_SEARCH_LENGTH,
} from "@/lib/contract-search";

describe("escapeLikePattern", () => {
  it("leaves ordinary text unchanged", () => {
    expect(escapeLikePattern("Office Lease 2026")).toBe("Office Lease 2026");
  });

  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLikePattern("50%_off\\v2")).toBe("50\\%\\_off\\\\v2");
  });
});

describe("capContractSearch", () => {
  it("leaves a search within the limit unchanged", () => {
    expect(capContractSearch("")).toBe("");
    expect(capContractSearch("  office lease ")).toBe("  office lease ");
    const longest = "a".repeat(MAX_CONTRACT_SEARCH_LENGTH);
    expect(capContractSearch(longest)).toBe(longest);
  });

  it("counts code points, as the list routes do, not UTF-16 code units", () => {
    const longest = "😀".repeat(MAX_CONTRACT_SEARCH_LENGTH);
    expect(longest).toHaveLength(2 * MAX_CONTRACT_SEARCH_LENGTH);
    expect(capContractSearch(longest)).toBe(longest);
    expect(capContractSearch(`${longest}😀`)).toBe(longest);
  });

  it("cuts a longer search between characters, never inside a surrogate pair", () => {
    const capped = capContractSearch(
      `${"a".repeat(MAX_CONTRACT_SEARCH_LENGTH - 1)}😀😀`,
    );
    expect(capped).toBe(`${"a".repeat(MAX_CONTRACT_SEARCH_LENGTH - 1)}😀`);
    expect([...capped]).toHaveLength(MAX_CONTRACT_SEARCH_LENGTH);
    expect(capContractSearch("b".repeat(5_000))).toBe(
      "b".repeat(MAX_CONTRACT_SEARCH_LENGTH),
    );
  });
});
