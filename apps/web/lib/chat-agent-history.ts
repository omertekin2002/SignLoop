import { modelMessageSchema, type ModelMessage } from "ai";
import { z } from "zod";

const historySchema = z.array(modelMessageSchema).max(36);
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

/** Accept only server-persisted assistant/tool turns; never replay system instructions from metadata. */
export function parseAgentMessages(value: unknown): ModelMessage[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    JSON.stringify(value).length > MAX_AGENT_STATE_CHARACTERS
  )
    return undefined;
  const parsed = historySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.some(
      (message) => message.role !== "assistant" && message.role !== "tool",
    )
  )
    return undefined;
  return parsed.data;
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

/** Keep recent complete assistant/tool exchanges; bound evidence without orphaning tool results. */
export function compactAgentMessages(
  value: unknown,
): ModelMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = historySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.some((m) => m.role !== "assistant" && m.role !== "tool")
  )
    return undefined;
  if (isPlainAssistantReplay(parsed.data)) return undefined;
  const clip = (text: string) =>
    text.length > 2_000
      ? `${text.slice(0, 2_000)}\n[Replay excerpt; read the source again for more detail.]`
      : text;
  const groups: ModelMessage[][] = [];
  for (const message of parsed.data) {
    if (message.role === "assistant") {
      groups.push([
        {
          ...message,
          content:
            typeof message.content === "string"
              ? clip(message.content)
              : message.content.map((part) =>
                  part.type === "text"
                    ? { ...part, text: clip(part.text) }
                    : part,
                ),
        },
      ]);
    } else if (message.role === "tool" && groups.length) {
      groups.at(-1)!.push({
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-result") return part;
          const serialized = JSON.stringify(part.output);
          return serialized.length > 2_000
            ? {
                ...part,
                output: { type: "text" as const, value: clip(serialized) },
              }
            : part;
        }),
      });
    }
  }
  const selected: ModelMessage[] = [];
  for (const group of groups.reverse()) {
    // A discarded tool-call must never leave its result behind in the replay.
    const calls = new Set(
      group.flatMap((m) =>
        m.role === "assistant" && Array.isArray(m.content)
          ? m.content
              .filter((p) => p.type === "tool-call")
              .map((p) => p.toolCallId)
          : [],
      ),
    );
    const results = new Set(
      group.flatMap((m) =>
        m.role === "tool"
          ? m.content
              .filter((p) => p.type === "tool-result")
              .map((p) => p.toolCallId)
          : [],
      ),
    );
    if (
      [...calls].some((id) => !results.has(id)) ||
      [...results].some((id) => !calls.has(id))
    )
      continue;
    if (
      JSON.stringify([...group, ...selected]).length >
      MAX_AGENT_STATE_CHARACTERS
    )
      break;
    selected.unshift(...group);
  }
  return selected.length && !isPlainAssistantReplay(selected)
    ? selected
    : undefined;
}
