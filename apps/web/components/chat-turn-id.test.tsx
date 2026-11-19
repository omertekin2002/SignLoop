import { render, waitFor } from "@testing-library/react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type AssistantRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { createChatTurnIds } from "@/lib/chat-turn-id";

// The chat panel keys turn ids by the user message the runtime hands its adapter. This pins the
// runtime behavior that relies on: Retry resends the same message, while an edit is a new one.
describe("saved-chat turn ids under the chat runtime", () => {
  it("reuses the turn id when Retry resends a failed message, and not after an edit", async () => {
    const turnIdFor = createChatTurnIds();
    const sent: string[] = [];
    let fail = true;
    const adapter: ChatModelAdapter = {
      async *run({ messages }) {
        const latest = messages.at(-1)!;
        sent.push(turnIdFor(latest.id));
        // End the first attempt as failed, as an interrupted stream does, without a thrown error
        // the runtime would leave unhandled.
        yield fail
          ? {
              status: {
                type: "incomplete",
                reason: "error",
                error: "Chat stream ended before completion.",
              },
            }
          : { content: [{ type: "text", text: "Answer" }] };
      },
    };
    let runtime!: AssistantRuntime;
    function Chat() {
      runtime = useLocalRuntime(adapter);
      return <AssistantRuntimeProvider runtime={runtime}>{null}</AssistantRuntimeProvider>;
    }
    render(<Chat />);
    // The runtime mounts its main thread in an effect.
    await waitFor(() => expect(() => runtime.thread.getState().messages).not.toThrow());
    const thread = runtime.thread;

    thread.append({ role: "user", content: [{ type: "text", text: "Question" }] });
    await waitFor(() => expect(thread.getState().isRunning).toBe(false));
    expect(thread.getState().messages.at(-1)?.status?.type).toBe("incomplete");

    // The error's Retry button reloads the failed assistant message.
    fail = false;
    thread.getMessageByIndex(1).reload();
    await waitFor(() => expect(sent).toHaveLength(2));
    await waitFor(() => expect(thread.getState().isRunning).toBe(false));
    expect(sent[1]).toBe(sent[0]);

    // Editing the question appends a replacement message in its place.
    thread.append({
      parentId: null,
      role: "user",
      content: [{ type: "text", text: "Edited question" }],
    });
    await waitFor(() => expect(sent).toHaveLength(3));
    await waitFor(() => expect(thread.getState().isRunning).toBe(false));
    expect(sent[2]).not.toBe(sent[0]);

    // A follow-up question is a new turn too.
    thread.append({ role: "user", content: [{ type: "text", text: "Follow-up" }] });
    await waitFor(() => expect(sent).toHaveLength(4));
    expect(new Set(sent.slice(1))).toHaveLength(3);
  });
});
