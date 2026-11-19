import { describe, expect, it } from "vitest";
import { createChatTurnIds } from "./chat-turn-id";

describe("createChatTurnIds", () => {
  it("reuses a message's turn id on retry and gives every other message a new one", () => {
    let next = 0;
    const turnIdFor = createChatTurnIds(() => `turn-${++next}`);

    expect(turnIdFor("message-a")).toBe("turn-1");
    expect(turnIdFor("message-a")).toBe("turn-1");
    // An edit or a new question is a new message, so it is a new turn.
    expect(turnIdFor("message-b")).toBe("turn-2");
    expect(turnIdFor("message-a")).toBe("turn-1");
  });

  it("creates UUIDs by default, which the chat route accepts", () => {
    const turnIdFor = createChatTurnIds();
    expect(turnIdFor("message")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(turnIdFor("other")).not.toBe(turnIdFor("message"));
  });
});
