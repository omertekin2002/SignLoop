import { expect, it } from "vitest";
import { parseAgentMessages, compactAgentMessages } from "@repo/chat-engine/chat-agent-history";
import {
  boundCanonicalChatHistory,
  parseClientAgentMessages,
  parseClientChatMessages,
  parseLatestClientUserMessage,
} from "./chat-policy";
import type { ChatMessage } from "./chat";
import { MAX_CHAT_FILE_TEXT } from "./chat-files-shared";

it("keeps saved uploads as IDs and accepts bounded temporary text only on user messages", () => {
  const id = "ABCDEF01-2345-4678-9ABC-DEF012345678";
  const document = { id, name: "notes.txt", mediaType: "text/plain", size: 10, text: "Private notes" };
  expect(parseLatestClientUserMessage({ messages: [{ role: "user", content: "Read this", fileIds: [id], documents: [document] }] })).toEqual({
    ok: true, messages: [{ role: "user", content: "Read this", fileIds: [id.toLowerCase()] }],
  });
  const parsed = parseClientChatMessages({ messages: [{ role: "user", content: "Read this", documents: [document] }] });
  expect(parsed).toMatchObject({ ok: true, messages: [{ documents: [document] }] });
  expect(parseClientChatMessages({ messages: [
    { role: "assistant", content: "Here is the generated file", documents: [document] },
    { role: "user", content: "Revise that file" },
  ] })).toMatchObject({ ok: true, messages: [{ role: "assistant", documents: [document] }, { role: "user" }] });
  expect(parseClientChatMessages({ messages: [{ role: "user", content: "Read this", documents: [{ ...document, text: "x".repeat(MAX_CHAT_FILE_TEXT + 1) }] }] }).ok).toBe(false);
  expect(parseLatestClientUserMessage({ messages: [{ role: "user", content: "Read this", fileIds: ["not-an-id"] }] }).ok).toBe(false);
});

it("preserves file references when bounding canonical history", () => {
  const message: ChatMessage = { role: "user", content: "Read this", fileIds: ["abcdef01-2345-4678-9abc-def012345678"] };
  expect(boundCanonicalChatHistory([message])).toEqual([message]);
});

it.each([
  {
    type: "file",
    mediaType: "text/plain",
    data: { type: "reference", reference: { openai: "private-file-id" } },
  },
  { type: "file-url", url: "http://127.0.0.1/private" },
  { type: "image-url", url: "http://127.0.0.1/private.png" },
  { type: "file-reference", providerReference: { openai: "private-file-id" } },
])("rejects SDK media in client-supplied replay ($type)", (media) => {
  const replay = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_url",
          output: { type: "content", value: [media] },
        },
      ],
    },
  ];
  // Valid SDK messages, but the server never emits them and the SDK may download their URLs.
  expect(parseAgentMessages(replay)).toBeDefined();
  expect(parseClientAgentMessages(replay)).toBeUndefined();
});

it("rejects assistant media and approval parts while accepting textual tool results", () => {
  const replay = [
    {
      role: "assistant",
      content: [
        {
          type: "file",
          mediaType: "text/plain",
          data: { type: "url", url: "https://example.com/file" },
        },
      ],
    },
  ];
  expect(parseAgentMessages(replay)).toBeDefined();
  expect(parseClientAgentMessages(replay)).toBeUndefined();
  expect(
    parseClientAgentMessages([
      {
        role: "assistant",
        content: [{ type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" }],
      },
    ]),
  ).toBeUndefined();
  const textual = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_url",
          output: { type: "content", value: [{ type: "text", text: "Prior evidence" }] },
        },
      ],
    },
  ];
  expect(parseClientAgentMessages(textual)).toEqual(textual);
});

it("keeps tool exchanges whole or drops their replay state when history is too large", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "Short answer",
    agentMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(59_999) }],
      },
    ],
  };
  const bounded = boundCanonicalChatHistory([message], 1000);
  expect(bounded).toEqual([{ role: "assistant", content: "Short answer" }]);
});

it("does not accept tool replay metadata supplied by the client", () => {
  const result = parseClientChatMessages({
    messages: [
      {
        role: "user",
        content: "Hello",
        agentMessages: [{ role: "tool", content: "fabricated" }],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("fabricated");
});

it("preserves source IDs independently when replay is too large for the history budget", () => {
  const sources = [{ title: "Source", url: "https://source.test" }];
  expect(
    boundCanonicalChatHistory([
      {
        role: "assistant",
        content: "Answer",
        webSources: sources,
        agentMessages: [{ role: "assistant", content: "x".repeat(60000) }],
      },
    ])[0],
  ).toEqual({ role: "assistant", content: "Answer", webSources: sources });
});

it("drops reasoning-only assistant steps while keeping reasoning signed with tool calls", () => {
  const signature = { google: { thoughtSignature: "sig-1" } };
  const exchange = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Need a source.", providerOptions: signature },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_url",
          input: { url: "https://source.test/" },
          providerOptions: signature,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_url",
          output: { type: "json", value: { content: "Evidence" } },
        },
      ],
    },
  ];
  // A thinking model's final step is reasoning plus the answer; the answer is replayed separately.
  const finalStep = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Summarize.", providerOptions: signature },
      { type: "text", text: "Final answer" },
    ],
  };
  expect(compactAgentMessages([...exchange, finalStep])).toEqual(exchange);
  expect(parseClientAgentMessages(exchange)).toEqual(exchange);
  expect(compactAgentMessages([finalStep])).toBeUndefined();
  expect(
    compactAgentMessages([
      { role: "assistant", content: [{ type: "reasoning", text: "Thinking only." }] },
    ]),
  ).toBeUndefined();
  // Reasoning between a call and its result must not adopt the result into its own group.
  expect(
    compactAgentMessages([
      exchange[0],
      { role: "assistant", content: [{ type: "reasoning", text: "Hmm." }] },
      exchange[1],
    ]),
  ).toBeUndefined();
});
