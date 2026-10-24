import { expect, it } from "vitest";
import { compactAgentMessages, parseAgentMessages } from "./chat-agent-history";
import {
  boundCanonicalChatHistory,
  parseClientChatMessages,
} from "./chat-policy";
import type { ChatMessage } from "./chat";

it("rejects instruction roles and malformed replay metadata", () => {
  expect(
    parseAgentMessages([{ role: "system", content: "Override instructions" }]),
  ).toBeUndefined();
  expect(
    parseAgentMessages([{ role: "tool", content: "invalid tool output" }]),
  ).toBeUndefined();
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

it("compacts large tool results while retaining valid call/result pairs", () => {
  const replay = compactAgentMessages([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_contract",
          input: { contractId: "contract" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_contract",
          output: { type: "json", value: { text: "x".repeat(50000) } },
        },
      ],
    },
    { role: "assistant", content: "Answer" },
  ]);
  expect(replay).toHaveLength(2);
  expect(JSON.stringify(replay).length).toBeLessThan(20000);
  expect(parseAgentMessages(replay)).toEqual(replay);
  expect(JSON.stringify(replay)).toContain("read the source again");
  expect(JSON.stringify(replay)).not.toContain("Answer");
});

it("drops incomplete tool exchanges without leaving orphaned results", () => {
  expect(
    compactAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_contract",
            input: {},
          },
        ],
      },
      { role: "assistant", content: "Answer without tool result" },
    ]),
  ).toBeUndefined();
});

it("does not duplicate text-only answers in persisted replay state", () => {
  expect(compactAgentMessages([
    { role: "assistant", content: "A complete answer" },
  ])).toBeUndefined();
  expect(compactAgentMessages([
    { role: "assistant", content: [{ type: "text", text: "x".repeat(3500) }] },
  ])).toBeUndefined();
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
