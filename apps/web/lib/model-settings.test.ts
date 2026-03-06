import { describe, expect, it } from "vitest";
import {
  IMAGE_GENERATION_MODEL,
  PRIMARY_MODEL_OPTIONS,
  isAllowedPrimaryModel,
  isUsablePrimaryModel,
} from "./model-settings";

describe("model settings", () => {
  it("accepts configured primary models", () => {
    for (const model of PRIMARY_MODEL_OPTIONS) {
      expect(isAllowedPrimaryModel(model)).toBe(true);
    }
  });

  it("rejects unknown models", () => {
    expect(isAllowedPrimaryModel("z-ai/glm-4.5-air:free")).toBe(false);
    expect(isAllowedPrimaryModel("random-model")).toBe(false);
  });

  it("accepts any non-image runtime model id", () => {
    expect(isUsablePrimaryModel("gpt-5.4")).toBe(true);
    expect(isUsablePrimaryModel("claude-4.7-experimental")).toBe(true);
  });

  it("rejects blank and image-only runtime model ids", () => {
    expect(isUsablePrimaryModel("")).toBe(false);
    expect(isUsablePrimaryModel("   ")).toBe(false);
    expect(isUsablePrimaryModel(IMAGE_GENERATION_MODEL)).toBe(false);
  });
});
