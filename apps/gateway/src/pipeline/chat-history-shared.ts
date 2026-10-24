// Ported from SignLoop apps/web/lib/chat-history-shared.ts at 7605fea16c981b1f027ae54e6ef03aada3363b1c.
// SignLoop keeps this module free of runtime "ai" imports for its browser bundle. The gateway has
// no client, but keeps the split so the replay/catalog contract matches the upstream module map.
import type { ModelMessage } from "ai";
import { z } from "zod";

/** Serialized cap on one replayed tool transcript. */
export const MAX_AGENT_STATE_CHARACTERS = 20_000;
export const MAX_SOURCE_CATALOG_CHARACTERS = 16_000;
export const MAX_SOURCE_COUNT = 64;
export const MAX_SOURCE_TITLE_CHARACTERS = 240;

/** Legacy catalogs used array positions. Explicit numbers survive catalog eviction. */
export function sourceCitationNumber(
  source: { number?: number },
  index: number,
): number {
  return source.number ?? index + 1;
}

/** Plain answers already live in canonical message content; replay adds no tool evidence. */
export function isPlainAssistantReplay(
  messages: readonly ModelMessage[],
): boolean {
  return (
    messages.length > 0 &&
    messages.every(
      (message) =>
        message.role === "assistant" &&
        (typeof message.content === "string" ||
          message.content.every((part) => part.type === "text")),
    )
  );
}

const sourcesSchema = z
  .array(
    z.object({
      number: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      title: z.string().max(MAX_SOURCE_TITLE_CHARACTERS),
      url: z
        .string()
        .max(2048)
        .url()
        .refine((value) => /^https?:/.test(value)),
      snippet: z.string().max(600).nullish(),
    }),
  )
  .max(MAX_SOURCE_COUNT)
  .refine((sources) => {
    const numbers = sources.map(sourceCitationNumber);
    return new Set(numbers).size === numbers.length;
  }, "Source citation numbers must be unique");

export function parseWebSources(value: unknown) {
  if (JSON.stringify(value ?? null).length > MAX_SOURCE_CATALOG_CHARACTERS)
    return undefined;
  const parsed = sourcesSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
