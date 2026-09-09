import { marked } from "marked";
import type { WebSearchSource } from "@/lib/gemini-search";

export function appendWebSourcesToMessage(
  message: string,
  sources: readonly WebSearchSource[],
): string {
  if (!message.trim() || !sources.length) return message;

  const cited = new Set<number>();
  // Inspect prose, excluding code blocks, inline code, and link destinations.
  marked.walkTokens(marked.lexer(message), (token) => {
    if (token.type !== "text") return;
    for (const match of token.raw.matchAll(/\[(\d+)\]/g)) {
      const number = Number(match[1]);
      if (number >= 1 && number <= sources.length) cited.add(number);
    }
  });
  if (!cited.size) return message;

  const links = [...cited]
    .sort((a, b) => a - b)
    .map((number) => {
      const source = sources[number - 1]!;
      // Explicit labels preserve citation numbers when only a subset is used.
      return `- [${number}] [${source.title}](<${source.url}>)`;
    });
  return `${message.trim()}\n\nSources:\n${links.join("\n")}`;
}
