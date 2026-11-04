import { expect, it } from "vitest";
import type { ThreadMessage } from "@assistant-ui/react";
import { toApiMessages } from "./chat-message-client";
import { parseClientChatMessages } from "./chat-policy";
import { savedChatFile } from "./chat-files-shared";
import { chatImage } from "./fixtures/chat-image";

// Only fields read by the serializer; no assistant-ui runtime is needed for this boundary test.
function message(
  role: "user" | "assistant",
  text: string,
  attachment = false,
): ThreadMessage {
  return {
    role,
    content: text ? [{ type: "text", text }] : [],
    attachments: attachment ? [{ id: "local-image" }] : [],
    metadata: { custom: {} },
  } as unknown as ThreadMessage;
}

it("round-trips a temporary image and its follow-up through the server's real validator", () => {
  const prepared = new Map([["temporary:local-image", chatImage]]);
  const history = [
    message("user", "", true),
    message("assistant", "A screenshot."),
    message("user", "What is highlighted?"),
  ];
  const payload = toApiMessages(history, prepared, "temporary", true);
  expect(payload[0]).toMatchObject({
    content: "Please read the attached files.",
    images: [chatImage],
    documents: [],
  });
  expect(payload[1]).not.toHaveProperty("images");
  expect(parseClientChatMessages({ messages: payload })).toMatchObject({
    ok: true,
  });
});

it("sends only saved file IDs and never copies image bytes into a saved chat request", () => {
  const prepared = new Map([
    ["saved:local-image", savedChatFile(chatImage, "thread")],
  ]);
  const payload = toApiMessages(
    [message("user", "", true)],
    prepared,
    "saved",
    false,
  );
  expect(payload[0]).toMatchObject({ fileIds: [chatImage.id] });
  expect(payload[0]).not.toHaveProperty("images");
  expect(JSON.stringify(payload)).not.toContain(chatImage.data);
});
