import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  lease: vi.fn(),
  history: vi.fn(),
  settings: vi.fn(),
  admission: vi.fn(),
  append: vi.fn(),
  title: vi.fn(),
  reply: vi.fn(),
  stream: vi.fn(),
  after: vi.fn(),
  gate: vi.fn(),
  contract: vi.fn(),
  context: vi.fn(),
  analyze: vi.fn(),
  createAnalysis: vi.fn(),
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: mocks.after,
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/server-db", () => ({
  claimGenerationOperation: mocks.lease,
  getRecentChatMessagesForThreadForUser: mocks.history,
  getUserSettingsByUserId: mocks.settings,
  appendChatMessagesToThread: mocks.append,
  getContractAnalysisGateForUser: mocks.gate,
  getContractWithLatestAnalysisForUser: mocks.contract,
  getProjectContextForAnalysis: mocks.context,
  createAnalysisForContract: mocks.createAnalysis,
}));
vi.mock("@/lib/chat-admission", async (original) => ({
  ...(await original<typeof import("./chat-admission")>()),
  admitChat: mocks.admission,
  admitAnalysis: mocks.admission,
}));
vi.mock("@/lib/chat-title", () => ({ generateChatTitle: mocks.title }));
vi.mock("@/lib/chat", () => ({
  generateChatReply: mocks.reply,
  generateChatReplyStream: mocks.stream,
}));
vi.mock("@/lib/analysis", () => ({ analyzeText: mocks.analyze }));
vi.mock("@/lib/telemetry", () => ({
  isTelemetryEnabled: false,
  flushTelemetry: vi.fn(),
}));

const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const reply = {
  message: "Synthetic answer",
  provider: "primary-openai-compatible",
  model: "model-a",
  webSearch: null,
};
const modelResponse = (ids: string[]) =>
  Response.json({ data: ids.map((id) => ({ id })) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function request(body: Record<string, unknown> = {}, signal?: AbortSignal) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    signal,
    body: JSON.stringify({
      threadId: id,
      messages: [{ role: "user", content: "Synthetic question" }],
      ...body,
    }),
  });
}
let now = 0;
let log: ReturnType<typeof vi.spyOn>;
let release: ReturnType<typeof vi.fn>;
let releaseAdmission: ReturnType<typeof vi.fn>;
const refreshes: ReturnType<typeof deferred<Response>>[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://provider.example/v1");
  vi.stubEnv("PRIMARY_LLM_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected outbound request");
    }),
  );
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  log = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  release = vi.fn(async () => {
    now += 3;
  });
  releaseAdmission = vi.fn(async () => {
    now += 2;
  });
  mocks.auth.mockResolvedValue({ userId: "owner" });
  mocks.lease.mockResolvedValue(release);
  mocks.history.mockResolvedValue([]);
  mocks.settings.mockResolvedValue({ primaryModel: "model-a" });
  mocks.admission.mockResolvedValue({ release: releaseAdmission });
  mocks.append.mockResolvedValue([]);
  mocks.title.mockResolvedValue(null);
  mocks.reply.mockResolvedValue(reply);
  mocks.stream.mockImplementation(async function* () {
    yield { type: "done", reply };
  });
  mocks.gate.mockResolvedValue({ hasText: true, status: "DRAFT" });
  mocks.contract.mockResolvedValue({
    id,
    text: "Synthetic contract",
    revision: "v1",
    projectId: null,
  });
  mocks.analyze.mockResolvedValue({
    result: {},
    provider: "primary",
    model: "model-a",
  });
  mocks.createAnalysis.mockResolvedValue({ id });
});
afterEach(async () => {
  for (const refresh of refreshes.splice(0))
    refresh.resolve(modelResponse(["cleanup"]));
  await Promise.all(mocks.after.mock.calls.map(([promise]) => promise));
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function warmDiscovery() {
  vi.spyOn(Date, "now").mockReturnValue(0);
  const fetchMock = vi.fn().mockResolvedValueOnce(modelResponse(["model-a"]));
  vi.stubGlobal("fetch", fetchMock);
  const models = await import("./model-settings");
  await models.getModelAvailabilitySnapshot();
  vi.mocked(Date.now).mockReturnValue(60_000);
  const refresh = deferred<Response>();
  refreshes.push(refresh);
  fetchMock.mockReturnValueOnce(refresh.promise);
  return { models, refresh, fetchMock };
}

describe("generation request lifecycle", () => {
  it.each(["chat", "analysis"])(
    "retains warm %s discovery in Next after without waiting for upstream",
    async (route) => {
      const { models, refresh, fetchMock } = await warmDiscovery();
      const response =
        route === "chat"
          ? await (await import("@/app/api/chat/route")).POST(request())
          : await (
              await import("@/app/api/contracts/[id]/analyze/route")
            ).POST(
              new Request("http://localhost/analyze", { method: "POST" }),
              { params: Promise.resolve({ id }) },
            );
      expect(response.status).toBe(200);
      expect(mocks.after).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
      expect(log).toHaveBeenCalledWith(
        "Generation timings",
        expect.objectContaining({
          route,
          outcome: "success",
          discoverySource: "stale-cache",
        }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      refresh.resolve(modelResponse(["model-b"]));
      await mocks.after.mock.calls[0]![0];
      expect(
        (await models.getModelAvailabilitySnapshot()).availablePrimaryModels,
      ).toEqual(["model-b"]);
    },
  );

  it.each(["chat", "analysis"])(
    "keeps %s independent startup reads concurrent and behind admission",
    async (route) => {
      const admission = deferred<{ release: typeof releaseAdmission }>();
      const reachedAdmission = deferred<void>();
      const reachedSettings = deferred<void>();
      const settings = deferred<{ primaryModel: string }>();
      const discovery = deferred<Response>();
      const context = deferred<[]>();
      const fetchMock = vi.fn().mockReturnValue(discovery.promise);
      vi.stubGlobal("fetch", fetchMock);
      mocks.admission.mockImplementation(() => {
        reachedAdmission.resolve();
        return admission.promise;
      });
      mocks.settings.mockImplementation(() => {
        reachedSettings.resolve();
        return settings.promise;
      });
      mocks.contract.mockResolvedValue({
        id,
        text: "Synthetic contract",
        revision: "v1",
        projectId: id,
      });
      mocks.context.mockReturnValue(context.promise);
      const response =
        route === "chat"
          ? (await import("@/app/api/chat/route")).POST(request())
          : (await import("@/app/api/contracts/[id]/analyze/route")).POST(
              new Request("http://localhost/analyze", { method: "POST" }),
              { params: Promise.resolve({ id }) },
            );
      await reachedAdmission.promise;
      expect(mocks.lease).toHaveBeenCalledOnce();
      expect(
        route === "chat" ? mocks.history : mocks.contract,
      ).toHaveBeenCalledOnce();
      expect(mocks.settings).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.context).not.toHaveBeenCalled();
      admission.resolve({ release: releaseAdmission });
      await reachedSettings.promise;
      expect(fetchMock).toHaveBeenCalledOnce();
      if (route === "analysis") expect(mocks.context).toHaveBeenCalledOnce();
      expect(mocks.reply).not.toHaveBeenCalled();
      expect(mocks.analyze).not.toHaveBeenCalled();
      settings.resolve({ primaryModel: "model-a" });
      discovery.resolve(modelResponse(["model-a"]));
      context.resolve([]);
      expect((await response).status).toBe(200);
      expect(mocks.after).not.toHaveBeenCalled(); // Cold discovery is awaited by the request.
    },
  );

  it("logs stream timings only after generation, title wait, persistence and release finish", async () => {
    await warmDiscovery();
    const output = deferred<void>();
    const generated = deferred<void>();
    const title = deferred<string>();
    const persistence = deferred<[]>();
    const persisting = deferred<void>();
    mocks.title.mockReturnValue(title.promise);
    mocks.append.mockImplementation(() => {
      persisting.resolve();
      return persistence.promise;
    });
    mocks.stream.mockImplementation(async function* (_messages, options) {
      now = 20;
      options.onTiming("provider_start");
      now = 30;
      options.onTiming("provider_first_useful");
      yield { type: "delta", text: reply.message };
      await output.promise;
      now = 80;
      generated.resolve();
      yield { type: "done", reply };
    });
    const response = await (
      await import("@/app/api/chat/route")
    ).POST(request({ stream: true }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"type":"delta"',
    );
    expect(log).not.toHaveBeenCalled();
    output.resolve();
    await generated.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(log).not.toHaveBeenCalled();
    now = 100;
    title.resolve("Synthetic title");
    await persisting.promise;
    expect(log).not.toHaveBeenCalled();
    now = 120;
    persistence.resolve([]);
    while (!(await reader.read()).done) {
      /* consume the done event and stream close */
    }
    expect(release).toHaveBeenCalledOnce();
    expect(releaseAdmission).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "Generation timings",
      expect.objectContaining({
        outcome: "success",
        totalMs: 125,
        phasesMs: expect.objectContaining({
          generation: 80,
          title_wait: 20,
          persistence: 20,
          release: 5,
        }),
        milestonesMs: expect.objectContaining({
          provider_start: 20,
          provider_first_useful: 30,
          first_output: 30,
          generation_complete: 80,
        }),
      }),
    );
    expect(response.headers.get("Server-Timing")).toBeNull();
  });

  it.each(["success", "unpersisted"] as const)(
    "preserves %s timings when the reader cancels after done during release",
    async (outcome) => {
      await warmDiscovery();
      const pendingRelease = deferred<void>();
      const releasing = deferred<void>();
      release.mockImplementation(async () => {
        releasing.resolve();
        await pendingRelease.promise;
        now += 3;
      });
      if (outcome === "unpersisted")
        mocks.append.mockRejectedValue(new Error("Synthetic storage failure"));
      const response = await (
        await import("@/app/api/chat/route")
      ).POST(request({ stream: true }));
      const reader = response.body!.getReader();
      try {
        const terminal = await reader.read();
        expect(terminal.done).toBe(false);
        expect(JSON.parse(new TextDecoder().decode(terminal.value))).toEqual(
          expect.objectContaining({
            type: "done",
            persisted: outcome === "success",
          }),
        );
        await releasing.promise;
        const signal = mocks.stream.mock.calls[0]![1].signal as AbortSignal;
        expect(signal.aborted).toBe(false);
        expect(log).not.toHaveBeenCalled();

        // The client returns on done and cancels its reader without waiting for EOF.
        await reader.cancel();
        expect(signal.aborted).toBe(true);
        expect(release).toHaveBeenCalledOnce();
        expect(releaseAdmission).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();

        now = 40;
        pendingRelease.resolve();
        await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
        expect(release).toHaveBeenCalledOnce();
        expect(releaseAdmission).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledExactlyOnceWith(
          "Generation timings",
          expect.objectContaining({
            outcome,
            totalMs: 45,
            phasesMs: expect.objectContaining({ release: 45 }),
          }),
        );
        expect(console.error).toHaveBeenCalledTimes(
          outcome === "unpersisted" ? 1 : 0,
        );
      } finally {
        pendingRelease.resolve();
        await reader.cancel();
      }
    },
  );

  it.each([false, true])(
    "records generation error/cancellation (cancelled=%s) after releasing gates",
    async (cancelled) => {
      await warmDiscovery();
      const abort = new AbortController();
      mocks.stream.mockImplementation(async function* () {
        now = 15;
        yield { type: "delta", text: "Synthetic partial" };
        now = 40;
        if (cancelled) abort.abort();
        throw new Error("Synthetic upstream failure");
      });
      const response = await (
        await import("@/app/api/chat/route")
      ).POST(request({ stream: true }, abort.signal));
      const body = await response.text();
      expect(body).toContain('"type":"delta"');
      expect(body.includes('"type":"error"')).toBe(!cancelled);
      expect(mocks.append).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(releaseAdmission).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Generation timings",
        expect.objectContaining({
          outcome: cancelled ? "cancelled" : "error",
          totalMs: 45,
          phasesMs: expect.objectContaining({ generation: 40, release: 5 }),
        }),
      );
    },
  );

  it.each([false, true])(
    "records persistence failure without discarding a useful reply (stream=%s)",
    async (stream) => {
      await warmDiscovery();
      mocks.append.mockRejectedValue(new Error("Synthetic storage failure"));
      const response = await (
        await import("@/app/api/chat/route")
      ).POST(request({ stream }));
      const body = await response.text();
      expect(body).toContain('"persisted":false');
      expect(body).toContain(reply.message);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Generation timings",
        expect.objectContaining({
          outcome: "unpersisted",
          phasesMs: expect.objectContaining({ persistence: 0, release: 5 }),
        }),
      );
    },
  );

  it("records a reader cancellation after the generator observes its operation signal", async () => {
    await warmDiscovery();
    const stopped = deferred<void>();
    mocks.stream.mockImplementation(async function* (_messages, options) {
      yield { type: "delta", text: "Synthetic partial" };
      if (!options.signal.aborted)
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      now = 25;
      stopped.resolve();
    });
    const response = await (
      await import("@/app/api/chat/route")
    ).POST(request({ stream: true }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await stopped.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(releaseAdmission).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "Generation timings",
      expect.objectContaining({ outcome: "cancelled", totalMs: 30 }),
    );
  });

  it.each([null, "owner"])(
    "keeps temporary chat timing-free for user=%s",
    async (userId) => {
      if (userId) await warmDiscovery();
      mocks.auth.mockResolvedValue({ userId });
      const response = await (
        await import("@/app/api/chat/route")
      ).POST(request({ temporary: true, stream: true }));
      await response.text();
      expect(log).not.toHaveBeenCalled();
      expect(mocks.stream).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          recordTelemetry: false,
          onTiming: undefined,
        }),
      );
      if (!userId) expect(fetch).not.toHaveBeenCalled();
    },
  );
});
