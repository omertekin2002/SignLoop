import { expect, it } from "vitest";
import { parseResearchMode } from "../src/pipeline/research-policy";
it("preserves the public research modes and default", () => {
  expect(parseResearchMode(undefined)).toBe("auto");
  for (const mode of ["auto", "always", "never"])
    expect(parseResearchMode(mode)).toBe(mode);
  for (const value of [null, false, "sometimes", {}, []])
    expect(parseResearchMode(value)).toBeNull();
});
