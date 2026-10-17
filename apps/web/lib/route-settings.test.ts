import { afterEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getUserSettingsByUserId,
  upsertUserSettings,
  getModelAvailabilitySnapshot,
  resolveAvailablePrimaryModel,
  selectableFallbackModels,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserSettingsByUserId: vi.fn(),
  upsertUserSettings: vi.fn(),
  getModelAvailabilitySnapshot: vi.fn(),
  resolveAvailablePrimaryModel: vi.fn(),
  selectableFallbackModels: ["openrouter/free"],
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  getUserSettingsByUserId,
  upsertUserSettings,
}));
vi.mock("@/lib/model-settings", () => ({
  getModelAvailabilitySnapshot,
  resolveAvailablePrimaryModel,
  SELECTABLE_FALLBACK_MODELS: selectableFallbackModels,
}));

import { GET, PUT } from "@/app/api/settings/route";

const settingsUrl = "http://localhost/api/settings";
const availablePrimaryModels = ["gpt-5", "gpt-5-mini"];
const availablePersonalities = ["bare-llm", "signloop-assistant"];
const updatedAt = "2026-10-01T00:00:00.000Z";

const snapshot = (models: string[] = availablePrimaryModels) => ({
  availablePrimaryModels: models,
  imageGenerationAvailable: false,
});

const savedRecord = (overrides: Record<string, unknown> = {}) => ({
  userId: "owner",
  primaryModel: "gpt-5",
  personality: "bare-llm",
  updatedAt,
  ...overrides,
});

const putRequest = (body?: string) =>
  new Request(settingsUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });

const putJson = (body: unknown) => putRequest(JSON.stringify(body));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/settings", () => {
  it("returns 401 without touching settings or model lookups when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(new Request(settingsUrl));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getUserSettingsByUserId).not.toHaveBeenCalled();
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalled();
  });

  it("returns the owner's saved settings with the available option lists", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(
      savedRecord({ primaryModel: "gpt-5-mini", personality: "signloop-assistant" }),
    );
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    resolveAvailablePrimaryModel.mockReturnValue("gpt-5-mini");

    const response = await GET(new Request(settingsUrl));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      primaryModel: "gpt-5-mini",
      personality: "signloop-assistant",
      availablePrimaryModels,
      availableFallbackModels: ["openrouter/free"],
      availablePersonalities,
    });
    expect(getUserSettingsByUserId).toHaveBeenCalledExactlyOnceWith("owner");
    expect(resolveAvailablePrimaryModel).toHaveBeenCalledExactlyOnceWith(
      "gpt-5-mini",
      availablePrimaryModels,
    );
  });

  it("scopes the settings read to the caller rather than any query-supplied user", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(null);
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

    await GET(new Request(`${settingsUrl}?userId=someone-else`));

    expect(getUserSettingsByUserId).toHaveBeenCalledExactlyOnceWith("owner");
  });

  it("reports the resolved model, not the saved one, when the saved model is unavailable", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(
      savedRecord({ primaryModel: "retired-model" }),
    );
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

    const response = await GET(new Request(settingsUrl));

    expect(response.status).toBe(200);
    expect((await response.json()).primaryModel).toBe("gpt-5");
    expect(resolveAvailablePrimaryModel).toHaveBeenCalledExactlyOnceWith(
      "retired-model",
      availablePrimaryModels,
    );
  });

  it("returns a null primary model when none resolves", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(savedRecord());
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot([]));
    resolveAvailablePrimaryModel.mockReturnValue(null);

    const response = await GET(new Request(settingsUrl));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.primaryModel).toBeNull();
    expect(body.availablePrimaryModels).toEqual([]);
  });

  it("falls back to the default personality when the owner has no saved settings", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(null);
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

    const response = await GET(new Request(settingsUrl));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.personality).toBe("bare-llm");
    expect(body.primaryModel).toBe("gpt-5");
    expect(resolveAvailablePrimaryModel).toHaveBeenCalledExactlyOnceWith(
      undefined,
      availablePrimaryModels,
    );
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["an unrecognised legacy value", "pirate"],
  ])(
    "falls back to the default personality when the stored personality is %s",
    async (_label, personality) => {
      auth.mockResolvedValue({ userId: "owner" });
      getUserSettingsByUserId.mockResolvedValue(savedRecord({ personality }));
      getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
      resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

      const response = await GET(new Request(settingsUrl));

      expect(response.status).toBe(200);
      expect((await response.json()).personality).toBe("bare-llm");
    },
  );

  it("uses the cached model snapshot unless refreshModels=1 is requested", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(null);
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

    await GET(new Request(settingsUrl));

    expect(getModelAvailabilitySnapshot).toHaveBeenCalledExactlyOnceWith({
      forceRefresh: false,
    });
  });

  it("forces a model refresh when refreshModels=1", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(null);
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

    await GET(new Request(`${settingsUrl}?refreshModels=1`));

    expect(getModelAvailabilitySnapshot).toHaveBeenCalledExactlyOnceWith({
      forceRefresh: true,
    });
  });

  it.each(["0", "true", ""])(
    "does not force a refresh for refreshModels=%j",
    async (value) => {
      auth.mockResolvedValue({ userId: "owner" });
      getUserSettingsByUserId.mockResolvedValue(null);
      getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
      resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

      await GET(new Request(`${settingsUrl}?refreshModels=${value}`));

      expect(getModelAvailabilitySnapshot).toHaveBeenCalledExactlyOnceWith({
        forceRefresh: false,
      });
    },
  );

  it("starts the model lookup without waiting for the settings read", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    let releaseSettings: (value: unknown) => void = () => {};
    getUserSettingsByUserId.mockReturnValue(
      new Promise((resolve) => {
        releaseSettings = resolve;
      }),
    );
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    resolveAvailablePrimaryModel.mockReturnValue("gpt-5");

    const pending = GET(new Request(settingsUrl));
    await vi.waitFor(() => {
      expect(getModelAvailabilitySnapshot).toHaveBeenCalledTimes(1);
    });
    expect(getUserSettingsByUserId).toHaveBeenCalledTimes(1);

    releaseSettings(savedRecord());
    const response = await pending;

    expect(response.status).toBe(200);
  });

  it("does not swallow a settings read failure", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockRejectedValue(new Error("connection refused"));
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());

    await expect(GET(new Request(settingsUrl))).rejects.toThrow(
      "connection refused",
    );
  });

  it("does not swallow a model availability failure", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getUserSettingsByUserId.mockResolvedValue(null);
    getModelAvailabilitySnapshot.mockRejectedValue(new Error("models down"));

    await expect(GET(new Request(settingsUrl))).rejects.toThrow("models down");
  });
});

describe("PUT /api/settings", () => {
  it("returns 401 without parsing the body or saving when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await PUT(putRequest("{not json"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalled();
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", ""],
    ["malformed JSON", "{not json"],
    ["a JSON null", "null"],
  ])("returns 400 without saving for %s", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PUT(putRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty object", {}],
    ["empty strings", { primaryModel: "", personality: "" }],
    ["whitespace only", { primaryModel: "  \t", personality: " \n " }],
    ["non-string values", { primaryModel: 5, personality: true }],
    ["null values", { primaryModel: null, personality: null }],
    ["a JSON array body", []],
    ["a JSON string body", "gpt-5"],
  ])("returns 400 without saving when %s are provided", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PUT(putJson(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No setting provided" });
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalled();
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it("saves an available primary model for the owner and returns the stored settings", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    upsertUserSettings.mockResolvedValue(
      savedRecord({ primaryModel: "gpt-5-mini" }),
    );

    const response = await PUT(putJson({ primaryModel: "gpt-5-mini" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      primaryModel: "gpt-5-mini",
      personality: "bare-llm",
      updatedAt,
    });
    expect(getModelAvailabilitySnapshot).toHaveBeenCalledExactlyOnceWith();
    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      primaryModel: "gpt-5-mini",
    });
  });

  it("trims whitespace around the model and personality before validating and saving", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    upsertUserSettings.mockResolvedValue(
      savedRecord({ personality: "signloop-assistant" }),
    );

    const response = await PUT(
      putJson({
        primaryModel: "  gpt-5 \n",
        personality: "\t signloop-assistant ",
      }),
    );

    expect(response.status).toBe(200);
    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      primaryModel: "gpt-5",
      personality: "signloop-assistant",
    });
  });

  it("does not re-check the primary model list when the cached snapshot already has it", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    upsertUserSettings.mockResolvedValue(savedRecord());

    await PUT(putJson({ primaryModel: "gpt-5" }));

    expect(getModelAvailabilitySnapshot).toHaveBeenCalledTimes(1);
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalledWith({
      forceRefresh: true,
    });
  });

  it("refreshes the model list once when the cached snapshot lacks the model, then saves it", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot
      .mockResolvedValueOnce(snapshot(["gpt-5"]))
      .mockResolvedValueOnce(snapshot(["gpt-5", "brand-new-model"]));
    upsertUserSettings.mockResolvedValue(
      savedRecord({ primaryModel: "brand-new-model" }),
    );

    const response = await PUT(putJson({ primaryModel: "brand-new-model" }));

    expect(response.status).toBe(200);
    expect((await response.json()).primaryModel).toBe("brand-new-model");
    expect(getModelAvailabilitySnapshot).toHaveBeenCalledTimes(2);
    expect(getModelAvailabilitySnapshot).toHaveBeenNthCalledWith(1);
    expect(getModelAvailabilitySnapshot).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
    });
    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      primaryModel: "brand-new-model",
    });
  });

  it("returns 409 with the current option lists when the model is unavailable even after a refresh", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot
      .mockResolvedValueOnce(snapshot(["gpt-5"]))
      .mockResolvedValueOnce(snapshot(["gpt-5-mini"]));

    const response = await PUT(putJson({ primaryModel: "retired-model" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Selected primary model is not currently available",
      availablePrimaryModels: ["gpt-5-mini"],
      availableFallbackModels: ["openrouter/free"],
    });
    expect(getModelAvailabilitySnapshot).toHaveBeenCalledTimes(2);
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it("returns 409 when the primary endpoint reports no models at all", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot([]));

    const response = await PUT(putJson({ primaryModel: "gpt-5" }));

    expect(response.status).toBe(409);
    expect((await response.json()).availablePrimaryModels).toEqual([]);
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it("pins a selectable fallback model without any availability lookup", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    upsertUserSettings.mockResolvedValue(
      savedRecord({ primaryModel: "openrouter/free" }),
    );

    const response = await PUT(putJson({ primaryModel: "openrouter/free" }));

    expect(response.status).toBe(200);
    expect((await response.json()).primaryModel).toBe("openrouter/free");
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalled();
    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      primaryModel: "openrouter/free",
    });
  });

  it("saves a valid personality alone without a model lookup or touching the model", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    upsertUserSettings.mockResolvedValue(
      savedRecord({ personality: "signloop-assistant" }),
    );

    const response = await PUT(putJson({ personality: "signloop-assistant" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      primaryModel: "gpt-5",
      personality: "signloop-assistant",
      updatedAt,
    });
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalled();
    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      personality: "signloop-assistant",
    });
  });

  it("saves a model and personality together", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    upsertUserSettings.mockResolvedValue(
      savedRecord({ primaryModel: "gpt-5-mini", personality: "bare-llm" }),
    );

    const response = await PUT(
      putJson({ primaryModel: "gpt-5-mini", personality: "bare-llm" }),
    );

    expect(response.status).toBe(200);
    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      primaryModel: "gpt-5-mini",
      personality: "bare-llm",
    });
  });

  it("ignores a non-string field and saves only the valid one", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    upsertUserSettings.mockResolvedValue(
      savedRecord({ personality: "signloop-assistant" }),
    );

    const response = await PUT(
      putJson({ primaryModel: 42, personality: "signloop-assistant" }),
    );

    expect(response.status).toBe(200);
    expect(getModelAvailabilitySnapshot).not.toHaveBeenCalled();
    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      personality: "signloop-assistant",
    });
  });

  it("returns 400 with the allowed personalities for an unknown personality", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PUT(putJson({ personality: "pirate" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid personality",
      availablePersonalities,
    });
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it("does not save a valid model when the accompanying personality is invalid", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());

    const response = await PUT(
      putJson({ primaryModel: "gpt-5", personality: "pirate" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid personality");
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it("reports an unavailable model before it reports an invalid personality", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());

    const response = await PUT(
      putJson({ primaryModel: "retired-model", personality: "pirate" }),
    );

    expect(response.status).toBe(409);
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });

  it("falls back to the default personality in the response when the saved row has none", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockResolvedValue(snapshot());
    upsertUserSettings.mockResolvedValue(savedRecord({ personality: null }));

    const response = await PUT(putJson({ primaryModel: "gpt-5" }));

    expect(response.status).toBe(200);
    expect((await response.json()).personality).toBe("bare-llm");
  });

  it("does not let the body override the owner", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    upsertUserSettings.mockResolvedValue(
      savedRecord({ personality: "signloop-assistant" }),
    );

    await PUT(
      putJson({ personality: "signloop-assistant", userId: "someone-else" }),
    );

    expect(upsertUserSettings).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      personality: "signloop-assistant",
    });
  });

  it("rethrows a database failure instead of mapping it to a client error", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    upsertUserSettings.mockRejectedValue(new Error("upsert failed"));

    await expect(
      PUT(putJson({ personality: "signloop-assistant" })),
    ).rejects.toThrow("upsert failed");
  });

  it("rethrows a model availability failure instead of mapping it to a client error", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getModelAvailabilitySnapshot.mockRejectedValue(new Error("models down"));

    await expect(PUT(putJson({ primaryModel: "gpt-5" }))).rejects.toThrow(
      "models down",
    );
    expect(upsertUserSettings).not.toHaveBeenCalled();
  });
});
