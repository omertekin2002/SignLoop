import { describe, expect, it } from "vitest";
import {
  appendWebSourcesToMessage,
  normalizeCitationMarkers,
  verifyFigures,
} from "./web-citations";

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

describe("foreign citation markers", () => {
  it("rewrites OpenAI-style markers so the linker can see them", () => {
    expect(normalizeCitationMarkers("was 14.35 TRY 【1†L23-L26】.")).toBe(
      "was 14.35 TRY [1].",
    );
    expect(normalizeCitationMarkers("plain 【2】 marker")).toBe("plain [2] marker");
  });

  it("links a source cited only in the foreign format", () => {
    const result = appendWebSourcesToMessage("Closed at 14.35 【1†L23-L26】.", sources);
    expect(result).toContain("Closed at 14.35 [1].");
    expect(result).toContain("- [1] [Source 1](<https://example.com/source1>)");
  });
});

describe("sources listed from what was fetched", () => {
  it("lists a page that was read even when the model cited nothing", () => {
    const result = appendWebSourcesToMessage("Closed at 14.35.", sources, {
      readThisTurn: [2],
    });
    expect(result).toContain("- [2] [Source 2](<https://example.com/source2>)");
    expect(result).not.toContain("Source 1");
  });

  it("keeps carried-over sources out unless this answer cites them", () => {
    const result = appendWebSourcesToMessage("Per [5], and also new data.", sources, {
      readThisTurn: [2],
    });
    expect(result).toContain("- [2] [Source 2]");
    expect(result).toContain("- [5] [Source 5]");
    expect(result).not.toContain("Source 1");
  });

  it("ignores out-of-range read numbers", () => {
    expect(appendWebSourcesToMessage("No figures here.", sources, { readThisTurn: [0, 99] })).toBe(
      "No figures here.",
    );
  });
});

describe("verifyFigures", () => {
  it("passes an answer with no measured figures", () => {
    expect(verifyFigures("There are 3 renewal options in 2026.", [])).toBe("ok");
  });

  it("flags figures stated when nothing was fetched", () => {
    expect(verifyFigures("It closed at 13.380 TRY, up 2.53%.", [])).toBe("no-evidence");
  });

  it("passes when a figure appears in the fetched text, including comma decimals", () => {
    expect(verifyFigures("It closed at 14.35 TRY.", ["Close 14.35 on Sep 8"])).toBe("ok");
    expect(verifyFigures("It closed at 14.35 TRY.", ["Kapanis 14,35"])).toBe("ok");
  });

  it("flags an answer whose figures appear nowhere in the fetched text", () => {
    expect(
      verifyFigures("Closed at 13.380 with volume 952.04 million.", [
        "The page only mentions 14.35 and 12.10.",
      ]),
    ).toBe("unmatched");
  });

  it("does not flag a derived value when another figure is grounded", () => {
    expect(
      verifyFigures("Closed at 14.35, up 2.53% from the prior session.", ["Close 14.35"]),
    ).toBe("ok");
  });

  it("ignores figures inside code blocks", () => {
    expect(verifyFigures("Use this:\n\n```js\nconst rate = 13.380;\n```", [])).toBe("ok");
  });
});
