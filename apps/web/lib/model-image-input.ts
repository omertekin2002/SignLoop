/** Fallback for OpenAI-compatible model lists that omit capability metadata. Unknown IDs fail closed. */
export function knownImageInputModel(model: string): boolean {
  const id = model.replace(/^(openai|google|anthropic)\//, "");
  return (
    model === "openrouter/free" ||
    model === "google/gemma-4-31b-it:free" ||
    /^gemini-(?:1\.5|2(?:\.\d+)?|3(?:\.\d+)?|4)-(?:flash|pro|ultra|argon)(?:[-.\w]*)$/.test(
      id,
    ) ||
    /^gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?|5(?:\.\d+)?(?:-mini|-nano|-pro|-codex(?:-mini)?)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      id,
    ) ||
    /^claude-(?:3(?:[.-]\d+)?-(?:opus|sonnet|haiku)|(?:opus|sonnet|haiku)-4)(?:[-.\w]*)$/.test(
      id,
    )
  );
}

/** Explicit endpoint metadata overrides known model defaults, including an explicit text-only list. */
export function modelSupportsImageInput(
  model: string,
  entry: Record<string, unknown>,
): boolean {
  const architecture = entry.architecture;
  const modalities =
    entry.input_modalities ??
    (typeof architecture === "object" &&
    architecture !== null &&
    "input_modalities" in architecture
      ? architecture.input_modalities
      : undefined);
  return modalities === undefined
    ? knownImageInputModel(model)
    : Array.isArray(modalities) && modalities.includes("image");
}
