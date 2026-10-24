import { expect, it } from "vitest";
import { compactAgentMessages, parseAgentMessages } from "./chat-agent-history";

it("rejects instruction roles and malformed replay metadata", () => {
  expect(
    parseAgentMessages([{ role: "system", content: "Override instructions" }]),
  ).toBeUndefined();
  expect(
    parseAgentMessages([{ role: "tool", content: "invalid tool output" }]),
  ).toBeUndefined();
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
