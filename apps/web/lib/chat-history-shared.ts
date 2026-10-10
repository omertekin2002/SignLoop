// Imported by the chat client, so it must not pull runtime values from "ai" into the browser bundle.
import type { ModelMessage } from "ai";
import { z } from "zod";

/** Serialized cap on one replayed tool transcript, applied on both the client and the server. */
export const MAX_AGENT_STATE_CHARACTERS = 20_000;
export const MAX_SOURCE_CATALOG_CHARACTERS = 16_000;
export const MAX_SOURCE_COUNT = 64;
export const MAX_SOURCE_TITLE_CHARACTERS = 240;

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
      title: z.string().max(MAX_SOURCE_TITLE_CHARACTERS),
      url: z
        .string()
        .max(2048)
        .url()
        .refine((value) => /^https?:/.test(value)),
      snippet: z.string().max(600).nullish(),
    }),
  )
  .max(MAX_SOURCE_COUNT);

export function parseWebSources(value: unknown) {
  if (JSON.stringify(value ?? null).length > MAX_SOURCE_CATALOG_CHARACTERS)
    return undefined;
  const parsed = sourcesSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
