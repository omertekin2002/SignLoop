import { describe, expect, it } from "vitest";
import {
  createOpenAiCompatibleClient,
  LlmResponseValidationError,
} from "./llm-client";

describe("createOpenAiCompatibleClient", () => {
  it("fails closed when the endpoint is absent", () => {
    expect(() => createOpenAiCompatibleClient("", "configured-key")).toThrow(
      /base URL is not configured/i,
    );
  });

  it("fails closed instead of inventing an authentication credential", () => {
    expect(() =>
      createOpenAiCompatibleClient("https://provider.example/v1"),
    ).toThrow(/API key is not configured/i);
  });

  it("rejects non-HTTP provider URLs", () => {
    expect(() =>
      createOpenAiCompatibleClient("file:///tmp/provider", "configured-key"),
    ).toThrow(/must use HTTP or HTTPS/i);
  });
});

describe("LlmResponseValidationError", () => {
  it("can be distinguished from transport failures by fallback policy", () => {
    const error = new LlmResponseValidationError("invalid structured output");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LlmResponseValidationError");
  });
});
