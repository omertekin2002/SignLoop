import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateChatReply } = vi.hoisted(() => ({
  generateChatReply: vi.fn(),
}));
vi.mock("@/lib/chat", () => ({ generateChatReply }));
import { generateChatTitle } from "./chat-title";

beforeEach(() => vi.resetAllMocks());

describe("chat titles", () => {
  it("uses the chat generator with the selected model and no tools", async () => {
    generateChatReply.mockResolvedValue({
      message: 'Title: "Lease Renewal Terms"',
    });
    const signal = new AbortController().signal;

    expect(
      await generateChatTitle("Explain my lease renewal.", {
        primaryModel: "selected-model",
        signal,
      }),
    ).toBe("Lease Renewal Terms");
    expect(generateChatReply).toHaveBeenCalledWith(
      [
        expect.objectContaining({ role: "system" }),
        { role: "user", content: '"Explain my lease renewal."' },
      ],
      { primaryModel: "selected-model", signal, maxOutputTokens: 512 },
    );
  });

  it("bounds quoted prompt content and titles without splitting Unicode characters", async () => {
    generateChatReply.mockResolvedValue({ message: `  ${"😀".repeat(100)}  ` });
    const title = await generateChatTitle("x".repeat(10_000), {
      primaryModel: null,
      signal: new AbortController().signal,
    });

    expect(Array.from(title)).toHaveLength(80);
    expect(title).toBe(`${"😀".repeat(79)}…`);
    expect(
      JSON.parse(generateChatReply.mock.calls[0]![0][1].content),
    ).toHaveLength(4000);
    expect(generateChatReply.mock.calls[0]![1].primaryModel).toBeNull();
  });

  it.each(["", "\n  ", '"New chat"', "Untitled."])(
    "rejects unusable title %j",
    async (message) => {
      generateChatReply.mockResolvedValue({ message });
      await expect(
        generateChatTitle("Hello", {
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("empty or generic");
    },
  );

  it("propagates provider failures for the route to handle independently of the reply", async () => {
    generateChatReply.mockRejectedValue(new Error("All providers failed"));
    await expect(
      generateChatTitle("Hello", {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("All providers failed");
  });
});
