import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("./openai-client", () => ({
  createOpenAiCompatibleClient: mocks.createClient,
}));

const config = {
  baseURL: "https://provider.example/v1",
  apiKey: "secret",
  model: "gpt-image-2.5-sunburst",
  referer: "https://signloop.test",
  appName: "SignLoop",
};

describe("generateImageReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({
      images: { generate: mocks.generate },
    });
  });

  it("forwards the prompt to gpt-image-2.5-sunburst and returns renderable markdown", async () => {
    mocks.generate.mockResolvedValue({
      data: [{ b64_json: "aW1hZ2U=" }],
    });
    const { generateImageReply } = await import("./image-generation");
    const signal = new AbortController().signal;

    await expect(
      generateImageReply("A signed contract on a desk", {
        config,
        signal,
        userId: "user-1",
      }),
    ).resolves.toEqual({
      message: "![Generated image](data:image/png;base64,aW1hZ2U=)",
      model: "gpt-image-2.5-sunburst",
      provider: "primary-openai-compatible",
    });
    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://provider.example/v1",
      "secret",
      { timeoutMs: 150_000, referer: "https://signloop.test", appName: "SignLoop" },
    );
    expect(mocks.generate).toHaveBeenCalledWith(
      {
        model: "gpt-image-2.5-sunburst",
        prompt: "A signed contract on a desk",
        n: 1,
        output_format: "png",
        quality: "medium",
        size: "1024x1024",
        user: "user-1",
      },
      { signal },
    );
  });

  it("rejects a successful response that contains no image", async () => {
    mocks.generate.mockResolvedValue({ data: [] });
    const { generateImageReply } = await import("./image-generation");

    await expect(generateImageReply("Missing image", { config })).rejects.toThrow(
      /no image data/i,
    );
  });

  it.each(["!invalid!", "aW1h\nZ2U=", "A".repeat(8 * 1024 * 1024 + 1)])(
    "rejects invalid or oversized image payloads",
    async (base64) => {
      mocks.generate.mockResolvedValue({ data: [{ b64_json: base64 }] });
      const { generateImageReply } = await import("./image-generation");
      await expect(generateImageReply("test", { config })).rejects.toThrow(
        /invalid or oversized/,
      );
    },
  );
});

describe("hostedImageMarkdown", () => {
  it("renders a hosted image_generation result that is a base64 PNG", async () => {
    const { hostedImageMarkdown } = await import("./image-generation");
    expect(hostedImageMarkdown({ result: " iVBORw0KGgoAAAANSUhEUg== " })).toBe(
      "![Generated image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==)",
    );
  });

  it.each([
    undefined,
    "iVBORw0KGgoAAAANSUhEUg==",
    { result: 42 },
    { result: "/9j/4AAQSkZJRgABAQ==" },
    { result: "iVBORw0KGgo!invalid!" },
    { result: `iVBORw0KGgo${"A".repeat(8 * 1024 * 1024)}` },
  ])("rejects outputs that are not a bounded base64 PNG", async (output) => {
    const { hostedImageMarkdown } = await import("./image-generation");
    expect(hostedImageMarkdown(output)).toBeNull();
  });
});
