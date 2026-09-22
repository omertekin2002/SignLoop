import { describe, expect, it } from "vitest";
import { assistantMessageForClient } from "./chat-public-message";

describe("assistantMessageForClient", () => {
  const drafted = "![Generated image](data:image/png;base64,AAAA)\n\nA diagram.";
  const stored = "![Generated image](/api/chat/threads/thread/images/image)\n\nA diagram.";

  it("shows the stored attachment URL after a saved reply is persisted", () => {
    expect(
      assistantMessageForClient(
        drafted,
        [
          { role: "user", content: "Draw it" },
          { role: "assistant", content: stored },
        ],
        true,
      ),
    ).toBe(stored);
  });

  it("keeps the drafted bytes when the reply was not persisted", () => {
    expect(
      assistantMessageForClient(
        drafted,
        [{ role: "assistant", content: stored }],
        false,
      ),
    ).toBe(drafted);
  });
});
