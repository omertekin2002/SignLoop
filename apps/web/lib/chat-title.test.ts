import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateChatReply } = vi.hoisted(() => ({
  generateChatReply: vi.fn(),
}));
vi.mock("@/lib/chat", () => ({ generateChatReply }));
import {
  CHAT_TITLE_MAX_OUTPUT_TOKENS,
  CHAT_TITLE_TIMEOUT_MS,
  generateChatTitle,
} from "./chat-title";

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

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
      { primaryModel: "selected-model", signal: expect.any(AbortSignal), maxOutputTokens: CHAT_TITLE_MAX_OUTPUT_TOKENS },
    );
  });

  it("aborts optional naming after its own short deadline even if the provider ignores cancellation", async () => {
    vi.useFakeTimers();
    generateChatReply.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = generateChatTitle("Hello", { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("title generation timed out");
    await vi.advanceTimersByTimeAsync(CHAT_TITLE_TIMEOUT_MS);
    await rejected;
    expect(generateChatReply.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the naming timer and cancels provider work when the request is canceled", async () => {
    vi.useFakeTimers();
    generateChatReply.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = generateChatTitle("Hello", { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("Canceled");
    controller.abort(new Error("Canceled"));
    await rejected;
    expect(generateChatReply.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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
