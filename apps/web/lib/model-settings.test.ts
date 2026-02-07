import { describe, expect, it } from "vitest";
import { PRIMARY_MODEL_OPTIONS, isAllowedPrimaryModel } from "./model-settings";

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
});

