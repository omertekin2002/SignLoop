// Ported from SignLoop apps/web/lib/chat-source-catalog.ts at 7605fea16c981b1f027ae54e6ef03aada3363b1c.
import type { WebSearchSource } from "./gemini-search";
import {
  MAX_SOURCE_CATALOG_CHARACTERS,
  MAX_SOURCE_COUNT,
  sourceCitationNumber,
} from "./chat-history-shared";

export const SOURCE_CATALOG_FULL_MESSAGE =
  "This reply has reached its limit of numbered sources, so no new pages can be added. Answer from the sources already read and disclose any remaining uncertainty.";

/** Gateway adaptation: this turn's own reads fill the catalog, or no unused number remains. */
export class SourceCatalogFullError extends Error {
  readonly publicMessage = SOURCE_CATALOG_FULL_MESSAGE;
  constructor() {
    super("Source catalog limit reached for this turn");
    this.name = "SourceCatalogFullError";
  }
}

/** Retire inherited sources without reusing their numbers or evicting this turn's evidence. */
export function createChatSourceCatalog(inherited: readonly WebSearchSource[]) {
  const sources = inherited.map((source, index) => ({
    ...source,
    number: sourceCitationNumber(source, index),
  }));
  const highestNumber = Math.max(0, ...sources.map((source) => source.number));
  let nextNumber = highestNumber + 1;
  const readThisTurn = new Set<number>();
  const fits = (catalog: readonly WebSearchSource[]) =>
    catalog.length <= MAX_SOURCE_COUNT &&
    JSON.stringify(catalog).length <= MAX_SOURCE_CATALOG_CHARACTERS;

  // Explicit IDs add framing to legacy catalogs near the cap. Keep the highest ID as the
  // allocation watermark: a turn with no new reads must not return a lower maximum that a
  // later turn could reuse. Once addSource allocates a higher ID, this entry can retire normally.
  while (!fits(sources)) {
    const index = sources.findIndex(
      (source) => source.number !== highestNumber,
    );
    if (index < 0) {
      const watermark = sources[0];
      // JSON escaping can make one valid legacy entry exceed the cap once numbered. Its
      // optional snippet can be dropped; the bounded title and exact URL fit without it.
      if (watermark?.snippet !== undefined) {
        delete watermark.snippet;
        continue;
      }
      throw new SourceCatalogFullError();
    }
    sources.splice(index, 1);
  }

  return {
    sources,
    readThisTurn,
    /**
     * Gateway addition: whether a page at this address could be numbered, checked before paying
     * for a fetch. The title is unknown until then, so this is a lower bound; addSource enforces
     * the exact limit. Reserving the longest escaped title would refuse pages that fit, and an
     * http_get redirect changes the address anyway, so a page that does not fit is refused uncited.
     */
    hasRoom(url = ""): boolean {
      if (sources.some((entry) => entry.url === url)) return true;
      if (!Number.isSafeInteger(nextNumber)) return false;
      return fits([
        ...sources.filter((entry) => readThisTurn.has(entry.number)),
        { number: nextNumber, title: "", url },
      ]);
    },
    addSource(source: WebSearchSource): number {
      const existing = sources.find((entry) => entry.url === source.url);
      if (existing) {
        readThisTurn.add(existing.number);
        return existing.number;
      }
      if (!Number.isSafeInteger(nextNumber)) throw new SourceCatalogFullError();
      const added = { ...source, number: nextNumber };
      const retained = [...sources, added];
      while (!fits(retained)) {
        const index = retained.findIndex(
          (entry) => entry !== added && !readThisTurn.has(entry.number),
        );
        if (index < 0) throw new SourceCatalogFullError();
        retained.splice(index, 1);
      }
      sources.splice(0, sources.length, ...retained);
      nextNumber++;
      readThisTurn.add(added.number);
      return added.number;
    },
  };
}
