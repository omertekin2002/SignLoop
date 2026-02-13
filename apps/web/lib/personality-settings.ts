export const PERSONALITY_OPTIONS = [
  "bare-llm",
  "signloop-assistant",
] as const;

export type PersonalityMode = (typeof PERSONALITY_OPTIONS)[number];

export const DEFAULT_PERSONALITY_MODE: PersonalityMode = "signloop-assistant";

const personalitySet = new Set<string>(PERSONALITY_OPTIONS);

export function isAllowedPersonalityMode(value: string): value is PersonalityMode {
  return personalitySet.has(value);
}
