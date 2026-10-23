import { afterEach, expect, it, vi } from "vitest";
import { GenerationTimings } from "./generation-timings";

afterEach(() => vi.restoreAllMocks());

it("measures overlapping phases and first-only milestones using a monotonic clock", () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const timings = new GenerationTimings("chat");
  timings.enabled = true;
  const endSettings = timings.start("settings");
  now = 110;
  const endDiscovery = timings.start("model_discovery");
  now = 120;
  endSettings();
  endSettings();
  now = 130;
  endDiscovery();
  timings.mark("provider_start");
  now = 150;
  timings.mark("provider_start");
  timings.mark("provider_first_useful");
  timings.discoverySource = "stale-cache";
  timings.outcome = "success";
  now = 180;
  timings.finish(false);
  timings.finish(false);
  expect(log).toHaveBeenCalledExactlyOnceWith("Generation timings", {
    route: "chat",
    outcome: "success",
    totalMs: 80,
    phasesMs: { settings: 20, model_discovery: 20 },
    milestonesMs: { provider_start: 30, provider_first_useful: 50 },
    discoverySource: "stale-cache",
  });
});

it.each([false, true])(
  "records failed phases and cancellation=%s without recording the error",
  async (cancelled) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const timings = new GenerationTimings("analysis");
    timings.enabled = true;
    timings.outcome = "error";
    await expect(
      timings.measure("generation", async () => {
        now = 40;
        throw new Error("private upstream content");
      }),
    ).rejects.toThrow("private upstream content");
    now = 45;
    timings.finish(cancelled);
    expect(log).toHaveBeenCalledExactlyOnceWith("Generation timings", {
      route: "analysis",
      outcome: cancelled ? "cancelled" : "error",
      totalMs: 45,
      phasesMs: { generation: 40 },
      milestonesMs: {},
    });
  },
);

it("emits no record when disabled for temporary chat", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const timings = new GenerationTimings("chat");
  timings.mark("provider_start");
  timings.start("generation")();
  timings.finish(false);
  expect(log).not.toHaveBeenCalled();
});
