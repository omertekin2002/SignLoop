// Setup for the jsdom "components" project in vitest.config.ts: DOM matchers, and unmounting
// after each test (Testing Library only cleans up automatically when Vitest globals are on).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
