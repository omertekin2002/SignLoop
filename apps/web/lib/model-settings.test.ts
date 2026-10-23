import { afterEach, describe, expect, it, vi } from "vitest";

function modelResponse(ids: string[]): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: ids.map((id) => ({ id, object: "model" })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getModelAvailabilitySnapshot", () => {
  it("loads models from a public endpoint without an API key", async () => {
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("PRIMARY_LLM_API_KEY", "");
    const fetchMock = vi.fn().mockResolvedValue(modelResponse(["model-a"]));
    vi.stubGlobal("fetch", fetchMock);

    const { getModelAvailabilitySnapshot } = await import("./model-settings");
    const snapshot = await getModelAvailabilitySnapshot({
      forceRefresh: true,
    });

    expect(snapshot.availablePrimaryModels).toEqual(["model-a"]);
    expect(snapshot.imageGenerationAvailable).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: undefined,
        cache: "no-store",
      }),
    );
  });

  it("advertises gpt-image-2 without offering image-only models for text", async () => {
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://provider.example/v1");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        modelResponse(["model-a", "gpt-image-2", "gpt-image-1"]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { getModelAvailabilitySnapshot } = await import("./model-settings");
    const snapshot = await getModelAvailabilitySnapshot({
      forceRefresh: true,
    });

    expect(snapshot).toEqual({
      availablePrimaryModels: ["model-a"],
      imageGenerationAvailable: true,
    });
  });

  it("bypasses a successful snapshot when a fresh list is requested", async () => {
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("PRIMARY_LLM_API_KEY", "secret");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(modelResponse(["model-a"]))
      .mockResolvedValueOnce(modelResponse(["model-b"]));
    vi.stubGlobal("fetch", fetchMock);

    const { getModelAvailabilitySnapshot } = await import("./model-settings");
    const first = await getModelAvailabilitySnapshot();
    const cached = await getModelAvailabilitySnapshot();
    const refreshed = await getModelAvailabilitySnapshot({
      forceRefresh: true,
    });

    expect(first.availablePrimaryModels).toEqual(["model-a"]);
    expect(cached.availablePrimaryModels).toEqual(["model-a"]);
    expect(refreshed.availablePrimaryModels).toEqual(["model-b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not call a hard-coded provider when no base URL is configured", async () => {
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "");
    vi.stubEnv("PRIMARY_LLM_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getModelAvailabilitySnapshot } = await import("./model-settings");
    const snapshot = await getModelAvailabilitySnapshot({
      forceRefresh: true,
    });

    expect(snapshot.availablePrimaryModels).toEqual([]);
    expect(snapshot.imageGenerationAvailable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveAvailablePrimaryModel", () => {
  it("keeps an available selection and replaces a removed one", async () => {
    const { resolveAvailablePrimaryModel } = await import("./model-settings");
    const available = ["model-a", "model-b"];

    expect(resolveAvailablePrimaryModel("model-b", available)).toBe("model-b");
    expect(resolveAvailablePrimaryModel("removed", available)).toBe("model-a");
    expect(resolveAvailablePrimaryModel("removed", [])).toBeNull();
  });

  it("lets a user pin the OpenRouter free model only when OpenRouter is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const configured = await import("./model-settings");
    expect(configured.SELECTABLE_FALLBACK_MODELS).toEqual(["openrouter/free"]);
    expect(configured.resolveAvailablePrimaryModel("openrouter/free", ["model-a"])).toBe("openrouter/free");
    expect(configured.resolveAvailablePrimaryModel("openrouter/free", [])).toBe("openrouter/free");
    expect(configured.orderOpenRouterModels("openrouter/free")[0]).toBe("openrouter/free");
    expect(configured.orderOpenRouterModels(null)).toEqual(configured.OPENROUTER_MODELS);

    vi.resetModules();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const unconfigured = await import("./model-settings");
    expect(unconfigured.SELECTABLE_FALLBACK_MODELS).toEqual([]);
    expect(unconfigured.resolveAvailablePrimaryModel("openrouter/free", ["model-a"])).toBe("model-a");
  });
});

describe("generation discovery grace", () => {
  async function setup(ids: string[] = ["model-a", "gpt-image-2"]) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("PRIMARY_LLM_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValueOnce(modelResponse(ids));
    vi.stubGlobal("fetch", fetchMock);
    const { getModelAvailabilitySnapshot: snapshot } =
      await import("./model-settings");
    await snapshot();
    const background: Promise<void>[] = [];
    const deferRefresh = vi.fn((promise: Promise<void>) => {
      background.push(promise);
    });
    const onSource = vi.fn();
    return {
      snapshot,
      fetchMock,
      background,
      deferRefresh,
      generation: { deferRefresh, onSource },
      onSource,
    };
  }

  function deferredResponse() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("returns stale text/image availability immediately and coalesces retained refreshes", async () => {
    const { snapshot, fetchMock, generation, background, onSource } =
      await setup();
    const upstream = deferredResponse();
    fetchMock.mockReturnValueOnce(upstream.promise);
    vi.setSystemTime(60_000);
    const results = await Promise.all([
      snapshot(generation),
      snapshot(generation),
    ]);
    expect(results).toEqual(
      Array(2).fill({
        availablePrimaryModels: ["model-a"],
        imageGenerationAvailable: true,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(background).toHaveLength(2); // Every request retains the shared work in its lifecycle.
    expect(onSource.mock.calls).toEqual([["stale-cache"], ["stale-cache"]]);
    upstream.resolve(
      modelResponse(["model-b", "chatgpt-image-latest", "gpt-image-1"]),
    );
    await Promise.all(background);
    expect(await snapshot(generation)).toEqual({
      availablePrimaryModels: ["model-b"],
      imageGenerationAvailable: false,
    });
    expect(onSource).toHaveBeenLastCalledWith("cache");
  });

  it("waits on the shared refresh at hard expiry instead of returning the stale snapshot", async () => {
    const { snapshot, fetchMock, generation, background, onSource } =
      await setup();
    const upstream = deferredResponse();
    fetchMock.mockReturnValueOnce(upstream.promise);
    vi.setSystemTime(119_999);
    await snapshot(generation);
    vi.setSystemTime(120_000);
    let settled = false;
    const expired = snapshot(generation).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onSource).toHaveBeenLastCalledWith("in-flight");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    upstream.resolve(modelResponse(["model-b"]));
    expect((await expired).availablePrimaryModels).toEqual(["model-b"]);
    await Promise.all(background);
  });

  it("cold generation requests await discovery and share a single upstream", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://provider.example/v1");
    const upstream = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(upstream.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { getModelAvailabilitySnapshot: snapshot } =
      await import("./model-settings");
    const deferRefresh = vi.fn();
    let settled = false;
    const requests = Promise.all([
      snapshot({ deferRefresh }),
      snapshot({ deferRefresh }),
    ]).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(deferRefresh).not.toHaveBeenCalled();
    upstream.resolve(modelResponse(["model-a"]));
    expect(
      (await requests).map((value) => value.availablePrimaryModels),
    ).toEqual([["model-a"], ["model-a"]]);
  });

  it("settings and forced refresh await discovery during generation's grace", async () => {
    const { snapshot, fetchMock, generation, deferRefresh } = await setup();
    const upstream = deferredResponse();
    fetchMock.mockReturnValueOnce(upstream.promise);
    vi.setSystemTime(60_000);
    let settingsSettled = false;
    let forcedSettled = false;
    const settings = snapshot().then((value) => {
      settingsSettled = true;
      return value;
    });
    const forced = snapshot({ ...generation, forceRefresh: true }).then(
      (value) => {
        forcedSettled = true;
        return value;
      },
    );
    await Promise.resolve();
    expect(settingsSettled).toBe(false);
    expect(forcedSettled).toBe(false);
    expect(deferRefresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    upstream.resolve(modelResponse(["model-b"]));
    expect((await settings).availablePrimaryModels).toEqual(["model-b"]);
    expect((await forced).availablePrimaryModels).toEqual(["model-b"]);
  });

  it("forced refresh bypasses even a fresh generation snapshot and returns failure honestly", async () => {
    const { snapshot, fetchMock, generation, deferRefresh } = await setup();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await snapshot({ ...generation, forceRefresh: true })).toEqual({
      availablePrimaryModels: [],
      imageGenerationAvailable: false,
    });
    expect(await snapshot()).toEqual({
      availablePrimaryModels: [],
      imageGenerationAvailable: false,
    });
    expect(deferRefresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not extend hard lifetime on failures, respects negative caching, and recovers", async () => {
    const { snapshot, fetchMock, generation, background } = await setup();
    fetchMock.mockRejectedValue(new Error("offline"));
    vi.setSystemTime(60_000);
    expect((await snapshot(generation)).availablePrimaryModels).toEqual([
      "model-a",
    ]);
    await Promise.all(background);
    expect((await snapshot()).availablePrimaryModels).toEqual([]);
    vi.setSystemTime(69_999);
    expect((await snapshot(generation)).availablePrimaryModels).toEqual([
      "model-a",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(70_000);
    await snapshot(generation);
    await Promise.all(background);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.setSystemTime(119_999);
    await snapshot(generation);
    await Promise.all(background);
    vi.setSystemTime(120_000);
    expect((await snapshot(generation)).availablePrimaryModels).toEqual([]);
    // A failure at 119999 did not extend success to 239999; the negative result still applies.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.setSystemTime(129_999);
    fetchMock.mockResolvedValueOnce(modelResponse(["recovered"]));
    expect((await snapshot(generation)).availablePrimaryModels).toEqual([
      "recovered",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("preserves successful empty lists and replaces an older nonempty success", async () => {
    const { snapshot, fetchMock, generation, background } = await setup();
    fetchMock.mockResolvedValueOnce(modelResponse([]));
    vi.setSystemTime(60_000);
    await snapshot({ forceRefresh: true });
    vi.setSystemTime(120_000);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await snapshot(generation)).toEqual({
      availablePrimaryModels: [],
      imageGenerationAvailable: false,
    });
    await Promise.all(background);
    expect(await snapshot(generation)).toEqual({
      availablePrimaryModels: [],
      imageGenerationAvailable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("negative-caches cold timeouts for ten seconds and then retries without stale data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://provider.example/v1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(modelResponse(["recovered"]));
    vi.stubGlobal("fetch", fetchMock);
    const { getModelAvailabilitySnapshot: snapshot } =
      await import("./model-settings");
    const deferRefresh = vi.fn();
    const first = snapshot({ deferRefresh });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await first).availablePrimaryModels).toEqual([]);
    vi.setSystemTime(14_999);
    expect((await snapshot({ deferRefresh })).availablePrimaryModels).toEqual(
      [],
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.setSystemTime(15_000);
    expect((await snapshot({ deferRefresh })).availablePrimaryModels).toEqual([
      "recovered",
    ]);
    expect(deferRefresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
