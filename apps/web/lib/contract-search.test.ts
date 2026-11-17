import { describe, expect, it } from "vitest";
import {
  capContractSearch,
  describeContractListFilters,
  escapeLikePattern,
  hasContractListFilters,
  isContractAddedFilter,
  isContractStatusFilter,
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

  it("does not count leading whitespace, which is trimmed before the search is sent", () => {
    const longest = "a".repeat(MAX_CONTRACT_SEARCH_LENGTH);
    expect(capContractSearch(` ${longest}`)).toBe(` ${longest}`);
    expect(capContractSearch(`\n\t  ${longest}b`)).toBe(`\n\t  ${longest}`);
    const emoji = "😀".repeat(MAX_CONTRACT_SEARCH_LENGTH);
    expect(capContractSearch(`  ${emoji}😀`)).toBe(`  ${emoji}`);
    // Whitespace after the first character is part of the term's length until the end is trimmed.
    expect(capContractSearch(`${longest} b`)).toBe(longest);
    expect(capContractSearch(" ".repeat(500))).toBe(" ".repeat(500));
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

describe("contract list filters", () => {
  it("accepts only the preset status and added values, not inherited property names", () => {
    expect(["analyzed", "draft"].every(isContractStatusFilter)).toBe(true);
    expect(["7d", "30d", "365d"].every(isContractAddedFilter)).toBe(true);
    for (const value of ["", "ANALYZED", "toString", "__proto__", "constructor"]) {
      expect(isContractStatusFilter(value)).toBe(false);
    }
    for (const value of ["", "30", "1d", "hasOwnProperty", "__proto__"]) {
      expect(isContractAddedFilter(value)).toBe(false);
    }
  });

  it("describes the active filters in words and knows when none is set", () => {
    expect(describeContractListFilters({})).toBe("");
    expect(hasContractListFilters({})).toBe(false);
    expect(hasContractListFilters({ status: null, added: null })).toBe(false);
    expect(describeContractListFilters({ status: "draft" })).toBe("not analyzed yet");
    expect(describeContractListFilters({ added: "365d" })).toBe("added in the last 12 months");
    expect(describeContractListFilters({ status: "analyzed", added: "7d" })).toBe(
      "analyzed, added in the last 7 days",
    );
    expect(hasContractListFilters({ added: "30d" })).toBe(true);
  });
});
