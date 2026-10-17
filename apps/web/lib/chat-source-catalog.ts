import type { WebSearchSource } from "@/lib/gemini-search";
import {
  MAX_SOURCE_CATALOG_CHARACTERS,
  MAX_SOURCE_COUNT,
  sourceCitationNumber,
} from "@/lib/chat-history-shared";

/** Retire inherited sources without reusing their numbers or evicting this turn's evidence. */
export function createChatSourceCatalog(inherited: readonly WebSearchSource[]) {
  const sources = inherited.map((source, index) => ({
    ...source,
    number: sourceCitationNumber(source, index),
  }));
  let nextNumber = Math.max(0, ...sources.map((source) => source.number)) + 1;
  const readThisTurn = new Set<number>();
  const fits = (catalog: readonly WebSearchSource[]) =>
    catalog.length <= MAX_SOURCE_COUNT &&
    JSON.stringify(catalog).length <= MAX_SOURCE_CATALOG_CHARACTERS;

  // Explicit IDs add a little framing to legacy catalogs that were already near the byte cap.
  while (!fits(sources)) sources.shift();

  return {
    sources,
    readThisTurn,
    addSource(source: WebSearchSource): number {
      const existing = sources.find((entry) => entry.url === source.url);
      if (existing) {
        readThisTurn.add(existing.number);
        return existing.number;
      }
      if (!Number.isSafeInteger(nextNumber))
        throw new Error("Source citation numbers exhausted");
      const added = { ...source, number: nextNumber };
      const retained = [...sources, added];
      while (!fits(retained)) {
        const index = retained.findIndex(
          (entry) => entry !== added && !readThisTurn.has(entry.number),
        );
        if (index < 0)
          throw new Error("Source catalog limit reached for this turn");
        retained.splice(index, 1);
      }
      sources.splice(0, sources.length, ...retained);
      nextNumber++;
      readThisTurn.add(added.number);
      return added.number;
    },
  };
}
