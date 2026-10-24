// Ported from SignLoop apps/web/lib/chat-agent-history.ts at 7605fea16c981b1f027ae54e6ef03aada3363b1c.
import { modelMessageSchema, type ModelMessage } from "ai";
import { z } from "zod";
import {
  isPlainAssistantReplay,
  MAX_AGENT_STATE_CHARACTERS,
} from "./chat-history-shared";

export {
  isPlainAssistantReplay,
  MAX_AGENT_STATE_CHARACTERS,
  MAX_SOURCE_CATALOG_CHARACTERS,
  MAX_SOURCE_COUNT,
  MAX_SOURCE_TITLE_CHARACTERS,
  parseWebSources,
} from "./chat-history-shared";

const historySchema = z.array(modelMessageSchema).max(36);

/** Accept only assistant/tool turns supplied by the caller; never replay system instructions from metadata. */
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

/** Keep tool exchanges; the canonical answer is replayed separately, without clipping it twice. */
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
      // Reasoning and signatures belong with the tool calls they precede; without a call
      // (e.g. a thinking model's final step) they would replay as an unpaired assistant turn.
      const content =
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call")
          ? message.content.filter((part) => part.type !== "text")
          : [];
      groups.push(
        content.length
          ? [
              {
                ...message,
                content,
              },
            ]
          : [],
      );
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
