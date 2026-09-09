import { describe, expect, it } from "vitest";
import { appendWebSourcesToMessage } from "./web-citations";

const sources = Array.from({ length: 8 }, (_, index) => ({
  title: `Source ${index + 1}`,
  url: `https://example.com/source${index + 1}`,
}));

describe("web citations", () => {
  it("does not append retrieved sources to an uncited greeting", () => {
    expect(appendWebSourcesToMessage("Wazzup! What's up?", sources)).toBe(
      "Wazzup! What's up?",
    );
  });

  it("links only cited sources and preserves their original numbers", () => {
    const result = appendWebSourcesToMessage(
      "One fact [3]. Another [1]. Again [3].",
      sources,
    );
    expect(result).toContain("- [1] [Source 1](<https://example.com/source1>)");
    expect(result).toContain("- [3] [Source 3](<https://example.com/source3>)");
    expect(result).not.toContain("Source 2");
    expect(result.match(/Source 3/g)).toHaveLength(1);
  });

  it.each([
    "See [source](https://example.com/source1).",
    "See [1](https://example.com/source1).",
    "Use `items[1]` in your code.",
    "```js\nitems[1]\n```",
    "Unknown source [99] or [0].",
  ])("does not add sources for links or non-citation text: %s", (message) => {
    expect(appendWebSourcesToMessage(message, sources)).toBe(message);
  });
});
