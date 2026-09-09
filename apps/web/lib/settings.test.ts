import { expect, it } from "vitest";
import { getModelSelection } from "./settings";

it("allows saving an explicit fallback pin when the current setting is automatic", () => {
  const models = ["openrouter/free"];
  expect(getModelSelection("", null, models)).toEqual({ model: "", hasChanges: false });
  expect(getModelSelection("openrouter/free", null, models))
    .toEqual({ model: "openrouter/free", hasChanges: true });
  expect(getModelSelection("openrouter/free", "openrouter/free", models))
    .toEqual({ model: "openrouter/free", hasChanges: false });
});

it("preserves saved selections and ignores unavailable selections", () => {
  const models = ["primary", "openrouter/free"];
  expect(getModelSelection("", "primary", models)).toEqual({ model: "primary", hasChanges: false });
  expect(getModelSelection("openrouter/free", "primary", models))
    .toEqual({ model: "openrouter/free", hasChanges: true });
  expect(getModelSelection("missing", "primary", models)).toEqual({ model: "primary", hasChanges: false });
  expect(getModelSelection("missing", null, [])).toEqual({ model: "", hasChanges: false });
});
