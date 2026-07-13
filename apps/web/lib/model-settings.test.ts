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
});
