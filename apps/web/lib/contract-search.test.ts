import { describe, expect, it } from "vitest";
import {
  capContractSearch,
  describeContractListFilters,
  escapeLikePattern,
  hasContractListFilters,
  isContractAddedFilter,
  isContractStatusFilter,
  MAX_CONTRACT_SEARCH_LENGTH,
  MIN_CONTRACT_TEXT_SEARCH_LENGTH,
  searchesContractText,
  splitExcerptMatches,
} from "@/lib/contract-search";

describe("searchesContractText", () => {
  it("looks in contract text from 3 code points, after trimming", () => {
    expect(MIN_CONTRACT_TEXT_SEARCH_LENGTH).toBe(3);
    expect(searchesContractText("")).toBe(false);
    expect(searchesContractText("ab")).toBe(false);
    expect(searchesContractText("  ab \n")).toBe(false);
    expect(searchesContractText("abc")).toBe(true);
    expect(searchesContractText(" 60 ")).toBe(false);
    expect(searchesContractText("60d")).toBe(true);
  });

  it("counts code points, not UTF-16 code units", () => {
    // Two emoji are four code units but two code points.
    expect(searchesContractText("😀😀")).toBe(false);
    expect(searchesContractText("😀😀😀")).toBe(true);
  });
});

describe("splitExcerptMatches", () => {
  const marked = (excerpt: string, search: string) =>
    splitExcerptMatches(excerpt, search)
      .map((part) => (part.match ? `[${part.text}]` : part.text))
      .join("");

  it("marks every case-insensitive match and keeps the text around it", () => {
    expect(marked("…a 60-day Notice period; notice is due…", "notice")).toBe(
      "…a 60-day [Notice] period; [notice] is due…",
    );
    expect(splitExcerptMatches("the notice", "NOTICE")).toEqual([
      { text: "the ", match: false },
      { text: "notice", match: true },
    ]);
  });

  it("takes regular-expression and LIKE characters in the search literally", () => {
    expect(marked("fee of 5% (net_30) [a.b] \\ c*d", "5% (net_30)")).toBe("fee of [5% (net_30)] [a.b] \\ c*d");
    expect(marked("a.b axb", "a.b")).toBe("[a.b] axb");
    expect(marked("x \\ y", "\\")).toBe("x [\\] y");
    expect(marked("c*d cd", "c*d")).toBe("[c*d] cd");
  });

  it("lets whitespace in the search match any run of whitespace in the excerpt", () => {
    expect(marked("sixty  day notice", "sixty day")).toBe("[sixty  day] notice");
    expect(marked("sixty day notice", "  sixty   day ")).toBe("[sixty day] notice");
  });

  it("returns the excerpt unmarked when the search is blank or absent from it", () => {
    expect(splitExcerptMatches("the notice", "  ")).toEqual([{ text: "the notice", match: false }]);
    expect(splitExcerptMatches("the notice", "renewal")).toEqual([{ text: "the notice", match: false }]);
    expect(splitExcerptMatches("", "notice")).toEqual([]);
  });

  it("matches characters outside the Basic Multilingual Plane whole", () => {
    expect(marked("rate 😀😀 here", "😀😀")).toBe("rate [😀😀] here");
  });
});

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
