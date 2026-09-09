import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/url-reader", () => ({ readUrl: vi.fn() }));
vi.mock("@/lib/server-db", () => ({ listContractsForChat: vi.fn(), getContractTextForUser: vi.fn() }));
vi.mock("@/lib/image-generation", () => ({ generateImageReply: vi.fn() }));
import { CONTRACT_WINDOW_CHARACTERS, excerptContract, fenceUntrusted } from "./chat-tools";

describe("excerptContract", () => {
  const text = `${"a".repeat(CONTRACT_WINDOW_CHARACTERS)}Clause 9. Indemnification survives termination. ${"b".repeat(700)}Clause 12. Indemnification cap applies.`;

  it("returns sequential windows with a continuation offset", () => {
    const first = excerptContract(text);
    expect(first).toMatchObject({ offset: 0, nextOffset: CONTRACT_WINDOW_CHARACTERS });
    expect(first.content).toHaveLength(CONTRACT_WINDOW_CHARACTERS);
    const rest = excerptContract(text, { offset: first.nextOffset! });
    expect(rest.content.startsWith("Clause 9.")).toBe(true);
    expect(rest.nextOffset).toBeNull();
    expect(excerptContract(text, { offset: 10_000_000 })).toMatchObject({ content: "", nextOffset: null });
  });

  it("returns merged excerpts around keyword matches", () => {
    const result = excerptContract(text, { find: "indemnification termination" });
    expect(result.matchCount).toBe(3);
    expect(result.content).toContain("Clause 9. Indemnification survives termination.");
    expect(result.content).toContain("Clause 12. Indemnification cap applies.");
    expect(result.content.split("[...]")).toHaveLength(2);
    expect(result.content.length).toBeLessThan(2_000);
    expect(excerptContract(text, { find: "arbitration" })).toMatchObject({ matchCount: 0, content: "" });
  });
});

it("fences untrusted content with explicit delimiters", () => {
  expect(fenceUntrusted("hello")).toMatch(/^<<<BEGIN UNTRUSTED CONTENT.*\nhello\n<<<END UNTRUSTED CONTENT>>>$/s);
});
