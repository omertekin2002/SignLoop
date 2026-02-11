export const PRIMARY_MODEL_OPTIONS = [
  "claude-opus-4-6-thinking",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-flash",
  "gemini-3-pro-high",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-oss-120b-medium",
] as const;

export type PrimaryModel = (typeof PRIMARY_MODEL_OPTIONS)[number];

const primaryModelSet = new Set<string>(PRIMARY_MODEL_OPTIONS);

export function isAllowedPrimaryModel(value: string): value is PrimaryModel {
  return primaryModelSet.has(value);
}
