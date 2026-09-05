import { describe, expect, it } from "vitest";
import {
  resolvePrimaryModel,
  PRIMARY_LLM_MODEL,
  createOpenAiCompatibleClient,
  LlmResponseValidationError,
} from "./llm-client";

describe("createOpenAiCompatibleClient", () => {
  it("fails closed when the endpoint is absent", () => {
    expect(() => createOpenAiCompatibleClient("", "configured-key")).toThrow(
      /base URL is not configured/i,
    );
  });

  it("supports intentionally unauthenticated compatible endpoints", () => {
    expect(() =>
      createOpenAiCompatibleClient("https://provider.example/v1"),
    ).not.toThrow();
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


it("distinguishes unavailable primary from the configured default", () => {
  expect(resolvePrimaryModel(null)).toBeNull();
  expect(resolvePrimaryModel(undefined)).toBe(PRIMARY_LLM_MODEL);
});
