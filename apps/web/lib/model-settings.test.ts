import { describe, expect, it } from "vitest";
import { isUsablePrimaryModel } from "./model-settings";

describe("model settings", () => {
  it("accepts any non-image runtime model id", () => {
    expect(isUsablePrimaryModel("gpt-5.4")).toBe(true);
    expect(isUsablePrimaryModel("claude-4.7-experimental")).toBe(true);
  });

  it("rejects blank and image-only runtime model ids", () => {
    expect(isUsablePrimaryModel("")).toBe(false);
    expect(isUsablePrimaryModel("   ")).toBe(false);
    expect(isUsablePrimaryModel("gemini-3.1-flash-image")).toBe(false);
  });
});
