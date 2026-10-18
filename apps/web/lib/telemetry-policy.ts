/** AI traces can contain tool arguments as well as prompts. Require explicit content opt-in. */
export function chatTelemetryOptions(allowed = true) {
  const enabled = allowed && process.env.LANGFUSE_RECORD_CONTENT === "true";
  return {
    functionId: "chat",
    isEnabled: enabled,
    recordInputs: enabled,
    recordOutputs: enabled,
  };
}
