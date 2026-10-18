import { afterEach, expect, it, vi } from "vitest";
import { chatTelemetryOptions } from "./telemetry-policy";

afterEach(() => vi.unstubAllEnvs());
it.each([undefined, "false", "1", "TRUE", ""])(
  "disables AI content tracing without explicit true (%s)",
  (value) => {
    vi.stubEnv("LANGFUSE_RECORD_CONTENT", value);
    expect(chatTelemetryOptions()).toMatchObject({
      isEnabled: false,
      recordInputs: false,
      recordOutputs: false,
    });
  },
);
it("permits opted-in saved chat, but never temporary chat", () => {
  vi.stubEnv("LANGFUSE_RECORD_CONTENT", "true");
  expect(chatTelemetryOptions()).toMatchObject({
    isEnabled: true,
    recordInputs: true,
    recordOutputs: true,
  });
  expect(chatTelemetryOptions(false)).toMatchObject({
    isEnabled: false,
    recordInputs: false,
    recordOutputs: false,
  });
});
