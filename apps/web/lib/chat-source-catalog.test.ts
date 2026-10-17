import { describe, expect, it } from "vitest";
import { createChatSourceCatalog } from "./chat-source-catalog";
import {
  MAX_SOURCE_CATALOG_CHARACTERS,
  parseWebSources,
} from "./chat-history-shared";
import { appendWebSourcesToMessage } from "./web-citations";

const oldSources = () =>
  Array.from({ length: 64 }, (_, index) => ({
    title: `Old ${index + 1}`,
    url: `https://old.test/${index + 1}`,
  }));

describe("bounded chat source catalogs", () => {
  it("retires inherited entries without renumbering remaining or new citations", () => {
    const inherited = oldSources();
    const catalog = createChatSourceCatalog(inherited);
    expect(catalog.addSource({ title: "New", url: "https://new.test" })).toBe(
      65,
    );
    expect(catalog.sources).toHaveLength(64);
    expect(catalog.sources[0]?.number).toBe(2);
    expect(catalog.sources.at(-1)?.number).toBe(65);
    expect(inherited[0]).not.toHaveProperty("number");
    const saved = parseWebSources(catalog.sources);
    expect(saved).toEqual(catalog.sources);
    const next = createChatSourceCatalog(saved!);
    expect(next.addSource({ title: "Next", url: "https://next.test" })).toBe(
      66,
    );
    expect(
      appendWebSourcesToMessage(
        "Old [64], new [65], archived [1]",
        catalog.sources,
      ),
    ).toContain("- [64] [Old 64]");
    expect(
      appendWebSourcesToMessage(
        "Old [64], new [65], archived [1]",
        catalog.sources,
      ),
    ).toContain("- [65] [New]");
    expect(appendWebSourcesToMessage("Archived [1]", catalog.sources)).toBe(
      "Archived [1]",
    );
  });

  it("keeps evidence read during this turn even when it was originally inherited", () => {
    const catalog = createChatSourceCatalog(oldSources());
    expect(catalog.addSource(oldSources()[0]!)).toBe(1);
    expect(catalog.addSource({ title: "New", url: "https://new.test" })).toBe(
      65,
    );
    expect(catalog.sources.some((source) => source.number === 1)).toBe(true);
    expect(catalog.sources.some((source) => source.number === 2)).toBe(false);
    expect([...catalog.readThisTurn]).toEqual([1, 65]);
  });

  it("evicts inherited entries to respect the character budget as well as the entry count", () => {
    const inherited = Array.from({ length: 7 }, (_, index) => ({
      title: "T".repeat(240),
      url: `https://old.test/${index}/${"x".repeat(1900)}`,
    }));
    const catalog = createChatSourceCatalog(inherited);
    expect(
      catalog.addSource({
        title: "T".repeat(240),
        url: `https://new.test/${"x".repeat(1900)}`,
      }),
    ).toBe(8);
    expect(catalog.sources.some((source) => source.number === 1)).toBe(false);
    expect(JSON.stringify(catalog.sources).length).toBeLessThanOrEqual(
      MAX_SOURCE_CATALOG_CHARACTERS,
    );
    expect(parseWebSources(catalog.sources)).toBeDefined();
  });

  it("never discards this turn's sources or mutates the catalog when this turn exhausts the budget", () => {
    const catalog = createChatSourceCatalog([]);
    for (let index = 0; index < 7; index++)
      catalog.addSource({
        title: "T".repeat(240),
        url: `https://source.test/${index}/${"x".repeat(1900)}`,
      });
    const before = JSON.stringify(catalog.sources);
    expect(() =>
      catalog.addSource({
        title: "T".repeat(240),
        url: `https://next.test/${"x".repeat(1900)}`,
      }),
    ).toThrow("limit reached for this turn");
    expect(JSON.stringify(catalog.sources)).toBe(before);
    expect(catalog.readThisTurn.size).toBe(7);
  });

  it("rejects duplicate citation numbers and supports catalogs with large stable IDs", () => {
    expect(
      parseWebSources([
        { number: 2, title: "One", url: "https://one.test" },
        { title: "Two", url: "https://two.test" },
      ]),
    ).toBeUndefined();
    const sources = [
      { number: 1001, title: "Current", url: "https://current.test" },
    ];
    expect(parseWebSources(sources)).toEqual(sources);
    expect(
      appendWebSourcesToMessage("Evidence 【1001†L1】", sources, {
        readThisTurn: [1001],
      }),
    ).toContain("- [1001] [Current]");
  });
});
