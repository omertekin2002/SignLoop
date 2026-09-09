import { modelMessageSchema, type ModelMessage } from "ai";
import { z } from "zod";

const historySchema = z.array(modelMessageSchema).max(36);

/** Accept only server-persisted assistant/tool turns; never replay system instructions from metadata. */
export function parseAgentMessages(value: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(value) || JSON.stringify(value).length > 120_000)
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
      title: z.string().max(240),
      url: z
        .string()
        .max(2048)
        .url()
        .refine((value) => /^https?:/.test(value)),
      snippet: z.string().max(600).nullish(),
    }),
  )
  .max(512);

export function parseWebSources(value: unknown) {
  const parsed = sourcesSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
