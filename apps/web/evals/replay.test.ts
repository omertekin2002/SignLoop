import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPatch,
  loadCases,
  loadOracles,
  loadPerturbations,
} from "./dataset";
import {
  oracleInteractions,
  REPLAY_MODEL,
  runReplay,
  type EvalRun,
} from "./harness";
import {
  caseMetrics,
  changedMetrics,
  imperfections,
  scoreCase,
  summarizeScores,
} from "./score";
import {
  createReplayTransport,
  REPLAY_BASE_URL,
  ReplayViolation,
  requestFingerprint,
} from "./transport";

const cases = loadCases();
const caseById = new Map(cases.map((loaded) => [loaded.spec.id, loaded]));
const oracles = new Map(loadOracles().map((oracle) => [oracle.case, oracle]));
const gym = caseById.get("gym-autorenew-01")!;
const gymOracle = oracles.get("gym-autorenew-01")!;
const RESPONSES_URL = `${REPLAY_BASE_URL}/responses`;

describe("replay transport", () => {
  it("refuses other endpoints even while a recorded response is waiting", async () => {
    const transport = createReplayTransport(
      oracleInteractions(gymOracle.output),
    );
    for (const [url, method] of [
      ["https://api.openai.com/v1/responses", "POST"],
      ["https://openrouter.ai/api/v1/responses", "POST"],
      [`${REPLAY_BASE_URL}/models`, "GET"],
    ]) {
      await expect(
        transport.fetch(url!, { method, body: "{}" }),
      ).rejects.toThrow(/Blocked unrecorded request/);
    }
    expect(transport.unusedInteractions()).toBe(1);
    expect(transport.violations).toHaveLength(3);
  });

  it("refuses a request once the recording is exhausted", async () => {
    const transport = createReplayTransport([]);
    await expect(
      transport.fetch(RESPONSES_URL, { method: "POST", body: "{}" }),
    ).rejects.toBeInstanceOf(ReplayViolation);
    expect(transport.violations).toEqual([
      "No recorded response for call 1 (0 recorded)",
    ]);
  });

  it.each([{ input: "prompt v2" }, { reasoning: { effort: "medium" } }])(
    "rejects a recording once its request changes: %j",
    async (change) => {
      const recorded = {
        model: "recorded-model",
        instructions: "Return only valid JSON with the exact required keys.",
        input: "prompt v1",
        max_output_tokens: 8192,
        text: { format: { type: "json_object" } },
        reasoning: { effort: "high" },
      };
      const interaction = {
        expect: { fingerprint: requestFingerprint(recorded) },
        response: { output: { risk_badge: "LOW" } },
      };
      const stale = createReplayTransport([interaction]);
      await expect(
        stale.fetch(RESPONSES_URL, {
          method: "POST",
          body: JSON.stringify({ ...recorded, ...change }),
        }),
      ).rejects.toThrow(/no longer matches its recording/);

      const current = createReplayTransport([interaction]);
      const response = await current.fetch(RESPONSES_URL, {
        method: "POST",
        body: JSON.stringify(recorded),
      });
      const body = await response.json();
      expect(body.output[0].content[0].text).toBe('{"risk_badge":"LOW"}');
    },
  );
});

describe("replay harness isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cannot reach a configured provider or OpenRouter fallback", async () => {
    // Simulate a developer .env.local with live provider settings.
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-local-developer-key");
    const realFetch = globalThis.fetch;

    const run = await runReplay(gym, [
      {
        response: {
          http: {
            status: 503,
            body: { error: { message: "Service unavailable" } },
          },
        },
      },
    ]);
    expect(run.parsePath).toBe("failed");
    expect(run.error).toMatch(/OpenRouter fallback is not configured/);
    expect(run.calls.map((call) => call.url)).toEqual([RESPONSES_URL]);
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("fails loudly on an unrecorded call instead of scoring it", async () => {
    await expect(runReplay(gym, [])).rejects.toThrow(
      /No recorded response for call 1/,
    );
  });

  it("fails when a recorded interaction is never requested", async () => {
    await expect(
      runReplay(gym, [
        ...oracleInteractions(gymOracle.output),
        ...oracleInteractions(gymOracle.output),
      ]),
    ).rejects.toThrow(/never requested/);
  });

  it("replays the JSON-mode compatibility retry", async () => {
    const run = await runReplay(gym, [
      {
        expect: { json_mode: true },
        response: {
          http: {
            status: 400,
            body: {
              error: {
                message: "Unsupported parameter: text.format",
                param: "text.format",
              },
            },
          },
        },
      },
      { expect: { json_mode: false }, response: { output: gymOracle.output } },
    ]);
    expect(run.error).toBeNull();
    expect(run.calls).toHaveLength(2);
    expect(imperfections(caseMetrics(scoreCase(gym, run)))).toEqual({});
  });

  it("observes rejected and salvaged output without a repair call", async () => {
    const rejected = await runReplay(gym, [
      {
        response: {
          output_text: '{"risk_badge":"LOW","key_points":["Monthly dues"]}',
        },
      },
    ]);
    expect(rejected).toMatchObject({ parsePath: "rejected", stored: null });
    expect(rejected.calls).toHaveLength(1);
    expect(
      caseMetrics(scoreCase(gym, rejected))[
        "fields.summary.renewal.auto_renew"
      ],
    ).toBe("no_result");

    const fenced = await runReplay(gym, [
      {
        response: {
          output_text: `\`\`\`json\n${JSON.stringify(gymOracle.output)}\n\`\`\``,
        },
      },
    ]);
    expect(fenced.parsePath).toBe("unobserved");
    expect(imperfections(caseMetrics(scoreCase(gym, fenced)))).toEqual({
      "parse.path": "unobserved",
    });
  });
});

describe("oracle responses through the production pipeline", () => {
  const runs = new Map<string, EvalRun>();

  beforeAll(async () => {
    for (const loaded of cases) {
      const oracle = oracles.get(loaded.spec.id)!;
      runs.set(
        loaded.spec.id,
        await runReplay(loaded, oracleInteractions(oracle.output)),
      );
    }
  });

  it.each(cases.map((loaded) => [loaded.spec.id, loaded] as const))(
    "%s scores its documented ideal",
    (id, loaded) => {
      const run = runs.get(id)!;
      expect(run.error).toBeNull();
      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]!.body).toMatchObject({
        model: REPLAY_MODEL,
        max_output_tokens: 8192,
        text: { format: { type: "json_object" } },
      });
      // The real prompt builder ran: every sent segment and context document is present, and
      // nothing from the omitted middle is.
      for (const segment of loaded.segments)
        expect(run.prompt).toContain(segment.text);
      for (const document of loaded.context)
        expect(run.prompt).toContain(document.text);
      for (const clause of loaded.clauses.filter(
        (candidate) => !candidate.reachable,
      )) {
        expect(run.prompt).not.toContain(clause.span);
      }
      expect(imperfections(caseMetrics(scoreCase(loaded, run)))).toEqual(
        oracles.get(id)!.ideal,
      );
    },
  );

  it("meets every headline target across the suite", () => {
    const summary = summarizeScores(
      cases.map((loaded) => scoreCase(loaded, runs.get(loaded.spec.id)!)),
    );
    expect(summary).toMatchObject({
      cases: 9,
      clauseRecall: 1,
      labelRecall: 1,
      spanPrecision: 1,
      quotes: { evidenceRate: 1, verificationRate: 1, diagnoses: {} },
      criticalErrors: 0,
      falseFlags: 0,
      benignAlarms: 0,
      unsupportedComparisons: 0,
      comparisonsWithheld: 9,
      jurisdiction: { correct: 8, correct_abstention: 1 },
      unverifiedJurisdictions: 0,
      dateRecall: 1,
      unsupportedDates: 0,
      partyRecall: 1,
    });
    expect(summary.autoRenewConfusion).toEqual({
      true: { true: 5, false: 0, null: 0 },
      false: { true: 0, false: 2, null: 0 },
      null: { true: 0, false: 0, null: 2 },
    });
    expect(summary.parsePaths).toEqual({ strict: 8, normalized: 1 });
  });

  it.each(
    loadPerturbations().map(
      (perturbation) => [perturbation.id, perturbation] as const,
    ),
  )("%s moves only its targeted metrics", async (_id, perturbation) => {
    const loaded = caseById.get(perturbation.case)!;
    const oracle = oracles.get(perturbation.case)!;
    const bad = await runReplay(
      loaded,
      oracleInteractions(applyPatch(oracle.output, perturbation.patch)),
    );
    const before = caseMetrics(scoreCase(loaded, runs.get(perturbation.case)!));
    const after = caseMetrics(scoreCase(loaded, bad));
    expect(changedMetrics(before, after)).toEqual(
      [...perturbation.targets].sort(),
    );
    expect(Object.keys(imperfections(after))).toEqual(
      expect.arrayContaining(perturbation.targets),
    );
  });
});
