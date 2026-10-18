import { vi } from "vitest";
import { AnalysisResultSchema, type AnalysisResult } from "@/lib/schemas";
import type { LoadedCase } from "./dataset";
import type { ParsePath, RunOutput } from "./score";
import {
  createReplayTransport,
  REPLAY_BASE_URL,
  ReplayViolation,
  type ReplayCall,
  type ReplayInteraction,
} from "./transport";

export const REPLAY_MODEL = "signloop-eval-replay";

// Provider settings are read from the environment when modules load, and `bun run` loads
// apps/web/.env.local. Point every provider at the reserved .invalid TLD and disable the
// OpenRouter chain, so even a transport bug could not reach a configured provider.
const REPLAY_ENVIRONMENT = {
  PRIMARY_LLM_BASE_URL: REPLAY_BASE_URL,
  PRIMARY_LLM_API_KEY: "replay-only",
  PRIMARY_LLM_MODEL: REPLAY_MODEL,
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "https://openrouter.replay.invalid/api/v1",
} as const;

// parseStrictJson logs this before accepting a normalized payload; it is the only signal of that path.
const NORMALIZATION_WARNING =
  "LLM response required normalization before passing strict validation";

export type EvalRun = RunOutput & {
  error: string | null;
  calls: ReplayCall[];
  provider: string | null;
};

/** A single completed JSON-mode response carrying a hand-written model output. */
export function oracleInteractions(output: unknown): ReplayInteraction[] {
  return [
    { expect: { model: REPLAY_MODEL, json_mode: true }, response: { output } },
  ];
}

function acceptedPath(raw: string | null, normalized: boolean): ParsePath {
  if (normalized) return "normalized";
  if (raw === null) return "unobserved";
  try {
    return AnalysisResultSchema.safeParse(JSON.parse(raw.trim())).success
      ? "strict"
      : "partial";
  } catch {
    // Production salvaged fenced or trailing-comma output; strict and partial look alike here.
    return "unobserved";
  }
}

/**
 * Runs one case through production analysis with replayed provider responses: the real prompt
 * builder, OpenAI SDK client, provider fallback, JSON salvage and validation, then the analyze
 * route's post-processing. It runs inside Vitest, owns environment and global stubs during the
 * run, and removes them afterwards. Replay violations fail the run instead of being scored.
 */
export async function runReplay(
  loaded: LoadedCase,
  interactions: readonly ReplayInteraction[],
): Promise<EvalRun> {
  const transport = createReplayTransport(interactions);
  const warnings: unknown[][] = [];
  vi.resetModules();
  for (const [name, value] of Object.entries(REPLAY_ENVIRONMENT)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal("fetch", transport.fetch);
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const { analyzeText } = await import("@/lib/analysis");
    const { finalizeAnalysisResult } = await import("@/lib/analysis-sources");
    let analysis: AnalysisResult | null = null;
    let stored: Record<string, unknown> | null = null;
    let provider: string | null = null;
    let failure: unknown = null;
    try {
      const answer = await analyzeText(loaded.text, undefined, {
        primaryModel: REPLAY_MODEL,
        contextDocuments: loaded.context,
      });
      analysis = answer.result;
      provider = answer.provider;
      stored = finalizeAnalysisResult(
        answer.result,
        { id: loaded.contractId, text: loaded.text },
        loaded.context,
      );
    } catch (caught) {
      failure = caught;
    }

    if (transport.violations.length) {
      throw new ReplayViolation(transport.violations.join("; "));
    }
    if (transport.unusedInteractions() > 0) {
      throw new ReplayViolation(
        `${transport.unusedInteractions()} recorded interaction(s) were never requested`,
      );
    }

    const served = transport.calls.filter((call) => call.servedText !== null);
    const input = transport.calls[0]?.body?.input;
    const rejected =
      failure instanceof Error && failure.name === "LlmResponseValidationError";
    return {
      analysis,
      stored,
      provider,
      parsePath: failure
        ? rejected
          ? "rejected"
          : "failed"
        : acceptedPath(
            served.at(-1)?.servedText ?? null,
            warnings.some((args) => args[0] === NORMALIZATION_WARNING),
          ),
      prompt: typeof input === "string" ? input : null,
      error: failure
        ? failure instanceof Error
          ? failure.message
          : String(failure)
        : null,
      calls: transport.calls,
    };
  } finally {
    warn.mockRestore();
    error.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}
