import { expect, it } from "vitest";
import {
  knownImageInputModel,
  modelSupportsImageInput,
} from "./model-image-input";

it("recognizes vision models and leaves text-only, audio-only, and unknown models out", () => {
  for (const model of [
    "gpt-4o",
    "gpt-4.1-mini",
    "gpt-5",
    "gpt-5.1-codex",
    "gemini-3-flash",
    "claude-sonnet-4-5",
    "google/gemma-4-31b-it:free",
    "openrouter/free",
  ])
    expect(knownImageInputModel(model), model).toBe(true);
  for (const model of [
    "openai/gpt-oss-120b:free",
    "gpt-oss-120b",
    "gpt-4o-transcribe",
    "o3-mini",
    "private-alias",
  ])
    expect(knownImageInputModel(model), model).toBe(false);
});

it("lets declared input modalities override defaults without guessing unknown aliases", () => {
  expect(
    modelSupportsImageInput("private-alias", {
      architecture: { input_modalities: ["text", "image"] },
    }),
  ).toBe(true);
  expect(modelSupportsImageInput("gpt-5", { input_modalities: ["text"] })).toBe(
    false,
  );
  expect(
    modelSupportsImageInput("gpt-5", {
      architecture: { input_modalities: [] },
    }),
  ).toBe(false);
  expect(modelSupportsImageInput("private-alias", {})).toBe(false);
});
