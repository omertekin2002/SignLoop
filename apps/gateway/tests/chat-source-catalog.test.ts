// Ported from SignLoop at 7605fea16c981b1f027ae54e6ef03aada3363b1c, with gateway room checks.
import { describe, expect, it } from "vitest";
import {
  createChatSourceCatalog,
  SourceCatalogFullError,
} from "../src/pipeline/chat-source-catalog";
import {
  MAX_SOURCE_CATALOG_CHARACTERS,
  parseWebSources,
} from "../src/pipeline/chat-history-shared";
import { appendWebSourcesToMessage } from "../src/pipeline/web-citations";

const oldSources = () =>
  Array.from({ length: 64 }, (_, index) => ({
    title: `Old ${index + 1}`,
    url: `https://old.test/${index + 1}`,
  }));

describe("bounded chat source catalogs", () => {
  it("retires inherited entries without renumbering remaining or new citations", () => {
    const inherited = oldSources();
    const catalog = createChatSourceCatalog(inherited);
    expect(catalog.hasRoom("https://new.test")).toBe(true);
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
    const next = `https://next.test/${"x".repeat(1900)}`;
    // Gateway: the pre-fetch check refuses before any provider or network call is paid for.
    expect(catalog.hasRoom(next)).toBe(false);
    expect(() =>
      catalog.addSource({ title: "T".repeat(240), url: next }),
    ).toThrow(SourceCatalogFullError);
    expect(JSON.stringify(catalog.sources)).toBe(before);
    expect(catalog.readThisTurn.size).toBe(7);
    // A page already numbered in this catalog can still be read again as fresh evidence.
    expect(catalog.hasRoom(catalog.sources[0]!.url)).toBe(true);
  });

  it("checks room before a fetch without reserving a title the page may not have", () => {
    const nearlyFull = () => {
      const catalog = createChatSourceCatalog([
        { number: 1, title: "Old", url: "https://old.test/" },
      ]);
      for (let index = 0; index < 7; index++)
        catalog.addSource({
          title: "T".repeat(240),
          url: `https://read.test/${index}/${"x".repeat(1900)}`,
        });
      const current = catalog.sources.filter((source) =>
        catalog.readThisTurn.has(source.number),
      );
      let url = "https://new.test/";
      // Leave 100 characters beyond an empty-titled entry for the new page.
      const spare =
        MAX_SOURCE_CATALOG_CHARACTERS -
        JSON.stringify([...current, { number: 9, title: "", url }]).length;
      url += "p".repeat(spare - 100);
      expect(spare).toBeGreaterThan(100);
      expect(url.length).toBeLessThanOrEqual(2048);
      expect(catalog.sources.map((source) => source.number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      return { catalog, url };
    };

    // A typical title fits, so the page is read, numbered, and the inherited entry retires.
    const fits = nearlyFull();
    expect(fits.catalog.hasRoom(fits.url)).toBe(true);
    expect(
      fits.catalog.addSource({ title: "A".repeat(60), url: fits.url }),
    ).toBe(9);
    expect(fits.catalog.sources.map((source) => source.number)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(parseWebSources(fits.catalog.sources)).toEqual(fits.catalog.sources);

    // A title too long once serialized, including JSON escapes, is refused after the fetch
    // without changing the catalog.
    for (const title of ["T".repeat(240), "\u0001".repeat(60)]) {
      const { catalog, url } = nearlyFull();
      const before = JSON.stringify(catalog.sources);
      expect(catalog.hasRoom(url)).toBe(true);
      expect(() => catalog.addSource({ title, url })).toThrow(
        SourceCatalogFullError,
      );
      expect(JSON.stringify(catalog.sources)).toBe(before);
      expect([...catalog.readThisTurn]).toEqual([2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it("rejects duplicate citation numbers and supports catalogs with large stable IDs", () => {
    expect(
      parseWebSources([
        { number: 2, title: "One", url: "https://one.test" },
        { title: "Two", url: "https://two.test" },
      ]),
    ).toBeUndefined();
    expect(
      parseWebSources([
        { number: 7, title: "One", url: "https://one.test" },
        { number: 7, title: "Two", url: "https://two.test" },
      ]),
    ).toBeUndefined();
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        parseWebSources([{ number, title: "Bad", url: "https://bad.test" }]),
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

  it("continues after the highest of gapped IDs and resolves mixed legacy positions", () => {
    // A legacy entry takes its position; explicit entries keep their own numbers.
    const catalog = createChatSourceCatalog([
      { number: 40, title: "Forty", url: "https://forty.test" },
      { title: "Two", url: "https://two.test" },
      { number: 9, title: "Nine", url: "https://nine.test" },
    ]);
    expect(catalog.sources.map((source) => source.number)).toEqual([40, 2, 9]);
    expect(catalog.addSource({ title: "New", url: "https://new.test" })).toBe(
      41,
    );
    expect(
      appendWebSourcesToMessage("See [2], [9], and [41].", catalog.sources),
    ).toContain("- [2] [Two]");
    expect(
      appendWebSourcesToMessage("See [2], [9], and [41].", catalog.sources),
    ).toContain("- [41] [New]");
  });

  it("numbers a repeated address once and records it as read", () => {
    const catalog = createChatSourceCatalog([
      { number: 5, title: "Kept", url: "https://kept.test" },
    ]);
    expect(catalog.readThisTurn.size).toBe(0);
    expect(
      catalog.addSource({ title: "Renamed", url: "https://kept.test" }),
    ).toBe(5);
    expect(catalog.addSource({ title: "New", url: "https://new.test" })).toBe(
      6,
    );
    expect(catalog.addSource({ title: "New", url: "https://new.test" })).toBe(
      6,
    );
    expect(catalog.sources).toEqual([
      { number: 5, title: "Kept", url: "https://kept.test" },
      { number: 6, title: "New", url: "https://new.test" },
    ]);
    expect([...catalog.readThisTurn]).toEqual([5, 6]);
  });

  it("refuses new sources once citation numbers are exhausted, without reusing retired ones", () => {
    const catalog = createChatSourceCatalog([
      {
        number: Number.MAX_SAFE_INTEGER,
        title: "Last",
        url: "https://last.test",
      },
    ]);
    expect(catalog.hasRoom("https://new.test")).toBe(false);
    expect(() =>
      catalog.addSource({ title: "New", url: "https://new.test" }),
    ).toThrow(SourceCatalogFullError);
    expect(catalog.addSource({ title: "Last", url: "https://last.test" })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([46, Number.MAX_SAFE_INTEGER])(
    "preserves the highest ID through migration-only turns before allocating again (%s)",
    (highestNumber) => {
      const inherited = Array.from({ length: 45 }, (_, index) => ({
        ...(index === 0 ? { number: highestNumber } : {}),
        title: "T".repeat(200),
        url: `https://old.test/${index}/${"x".repeat(100)}`,
      }));
      // Accepted input fits, but adding numbers to the legacy entries requires pruning.
      const padding = 15_990 - JSON.stringify(inherited).length;
      expect(padding).toBeGreaterThan(0);
      inherited.at(-1)!.url += "x".repeat(padding);
      expect(inherited.at(-1)!.url.length).toBeLessThanOrEqual(2048);
      expect(parseWebSources(inherited)).toBeDefined();

      let catalog = createChatSourceCatalog(inherited);
      expect(catalog.sources.length).toBeLessThan(inherited.length);
      // A turn without a fresh read returns only this catalog as its allocation state.
      for (let turn = 0; turn < 2; turn++) {
        expect(catalog.readThisTurn.size).toBe(0);
        expect(
          catalog.sources.find((source) => source.number === highestNumber)
            ?.url,
        ).toBe(inherited[0]!.url);
        const saved = parseWebSources(
          JSON.parse(JSON.stringify(catalog.sources)),
        );
        expect(saved).toBeDefined();
        catalog = createChatSourceCatalog(saved!);
      }

      const differentPage = {
        title: "Different page",
        url: `https://new.test/${"x".repeat(1900)}`,
      };
      if (highestNumber === Number.MAX_SAFE_INTEGER) {
        expect(catalog.hasRoom(differentPage.url)).toBe(false);
        expect(() => catalog.addSource(differentPage)).toThrow(
          SourceCatalogFullError,
        );
      } else {
        expect(catalog.addSource(differentPage)).toBe(highestNumber + 1);
        // The new, higher ID now carries the watermark, so the previous entry can retire.
        expect(
          catalog.sources.some((source) => source.number === highestNumber),
        ).toBe(false);
        expect(
          appendWebSourcesToMessage(
            `Earlier citation [${highestNumber}]`,
            catalog.sources,
          ),
        ).not.toContain(`- [${highestNumber}] [Different page]`);
      }
    },
  );

  it("compacts optional metadata when numbering an escaped single-source catalog exceeds the cap", () => {
    const inherited = [
      {
        title: "\0".repeat(240),
        url: "https://example.test/" + "\0".repeat(2027),
        snippet: "\0".repeat(389),
      },
    ];
    expect(JSON.stringify(inherited).length).toBe(15_993);
    expect(parseWebSources(inherited)).toBeDefined();

    const catalog = createChatSourceCatalog(inherited);
    expect(catalog.readThisTurn.size).toBe(0);
    expect(catalog.sources).toEqual([
      {
        number: 1,
        title: inherited[0]!.title,
        url: inherited[0]!.url,
      },
    ]);
    expect(inherited[0]!.snippet).toBe("\0".repeat(389));
    expect(JSON.stringify(catalog.sources).length).toBeLessThanOrEqual(
      MAX_SOURCE_CATALOG_CHARACTERS,
    );

    const saved = parseWebSources(JSON.parse(JSON.stringify(catalog.sources)));
    expect(saved).toEqual(catalog.sources);
    const next = createChatSourceCatalog(saved!);
    expect(next.addSource({ title: "New", url: "https://new.test/" })).toBe(2);
    expect(next.sources[0]!.url).toBe(inherited[0]!.url);
  });

  it("drops the oldest legacy entries when explicit numbers push a valid catalog over the byte cap", () => {
    const inherited: Array<{ title: string; url: string }> = [];
    const entry = (index: number) => ({
      title: "T".repeat(200),
      url: `https://old.test/${index}/${"x".repeat(100)}`,
    });
    while (
      JSON.stringify([...inherited, entry(inherited.length)]).length <=
      MAX_SOURCE_CATALOG_CHARACTERS
    )
      inherited.push(entry(inherited.length));
    expect(parseWebSources(inherited)).toBeDefined();
    const catalog = createChatSourceCatalog(inherited);
    expect(catalog.sources.length).toBeLessThan(inherited.length);
    expect(catalog.sources[0]!.number).toBeGreaterThan(1);
    expect(catalog.sources.at(-1)!.number).toBe(inherited.length);
    expect(JSON.stringify(catalog.sources).length).toBeLessThanOrEqual(
      MAX_SOURCE_CATALOG_CHARACTERS,
    );
  });
});
