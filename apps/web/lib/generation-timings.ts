import type { ModelDiscoverySource } from "@/lib/model-settings";

type Phase =
  | "auth"
  | "lease"
  | "history"
  | "gate"
  | "contract"
  | "admission"
  | "settings"
  | "model_discovery"
  | "context"
  | "generation"
  | "title_wait"
  | "persistence"
  | "release";
export type GenerationMilestone =
  | "provider_start"
  | "provider_first_useful"
  | "first_output"
  | "generation_complete"
  | "response_ready";
type Outcome =
  "success" | "unpersisted" | "error" | "cancelled" | "rejected" | "reused";

/** One bounded, content-free record at the end of the actual request/stream lifecycle.
 * Phase durations can overlap; milestones are offsets from request entry, not durations.
 * Disabled until a chat request is known to be saved, including for signed-in temporary chat. */
export class GenerationTimings {
  enabled = false;
  outcome: Outcome = "rejected";
  discoverySource?: ModelDiscoverySource;
  private readonly startedAt = performance.now();
  private readonly phasesMs: Partial<Record<Phase, number>> = {};
  private readonly milestonesMs: Partial<Record<GenerationMilestone, number>> =
    {};
  private finished = false;

  constructor(private readonly route: "chat" | "analysis") {}

  start(phase: Phase): () => void {
    const start = performance.now();
    let ended = false;
    return () => {
      if (ended || this.finished) return;
      ended = true;
      this.phasesMs[phase] =
        (this.phasesMs[phase] ?? 0) + performance.now() - start;
    };
  }

  async measure<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
    const end = this.start(phase);
    try {
      return await work();
    } finally {
      end();
    }
  }

  mark = (milestone: GenerationMilestone): void => {
    if (!this.finished && this.milestonesMs[milestone] === undefined) {
      this.milestonesMs[milestone] = performance.now() - this.startedAt;
    }
  };

  finish(cancelled: boolean): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.enabled) return;
    const round = (values: Partial<Record<string, number>>) =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          Math.round(value! * 10) / 10,
        ]),
      );
    console.info("Generation timings", {
      route: this.route,
      outcome: cancelled ? "cancelled" : this.outcome,
      totalMs: Math.round((performance.now() - this.startedAt) * 10) / 10,
      phasesMs: round(this.phasesMs),
      milestonesMs: round(this.milestonesMs),
      ...(this.discoverySource
        ? { discoverySource: this.discoverySource }
        : {}),
    });
  }
}
