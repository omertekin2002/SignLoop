import { expect, it, vi } from "vitest";

vi.mock("ai", () => {
  throw new Error("The ai package was loaded at runtime.");
});

it("loads the chat helpers the browser imports without the ai package", async () => {
  const shared = await import("./chat-history-shared");
  const bounds = await import("./chat-history-bounds");

  expect(
    shared.parseWebSources([{ title: "Source", url: "https://source.test/" }]),
  ).toHaveLength(1);
  expect(
    bounds.boundTemporaryChatHistory([{ role: "user", content: "Hello" }]),
  ).toEqual([{ role: "user", content: "Hello" }]);
});

it("detects a runtime ai import", async () => {
  await expect(import("./chat-agent-history")).rejects.toThrow();
});
