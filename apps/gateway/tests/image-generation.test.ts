// Ported from SignLoop at 61c90b508a789cee988acdded52b2d1a8c82ee69.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("../src/pipeline/llm-client", () => ({
  createOpenAiCompatibleClient: mocks.createClient,
  PRIMARY_LLM_API_KEY: "secret",
  PRIMARY_LLM_BASE_URL: "https://provider.example/v1",
}));

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
    const { generateImageReply } =
      await import("../src/pipeline/image-generation");
    const signal = new AbortController().signal;

    await expect(
      generateImageReply("A signed contract on a desk", {
        ...imageOptions,
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
      {
        timeoutMs: 150_000,
        publicServiceUrl: "https://service.test",
        appName: "Test",
      },
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
    const { generateImageReply } =
      await import("../src/pipeline/image-generation");

    await expect(
      generateImageReply("Missing image", imageOptions),
    ).rejects.toThrow(/no image data/i);
  });
});

const imageOptions = {
  providerConfig: {
    primary: {
      baseURL: "https://provider.example/v1",
      apiKey: "secret",
      model: "text-model",
    },
    publicServiceUrl: "https://service.test",
    appName: "Test",
  },
  model: "gpt-image-2.5-sunburst",
};

it.each(["!invalid!", "A".repeat(8 * 1024 * 1024 + 1)])(
  "rejects invalid or oversized image payloads",
  async (base64) => {
    mocks.generate.mockResolvedValue({ data: [{ b64_json: base64 }] });
    mocks.createClient.mockReturnValue({
      images: { generate: mocks.generate },
    });
    const { generateImageReply } =
      await import("../src/pipeline/image-generation");
    await expect(generateImageReply("test", imageOptions)).rejects.toThrow(
      /invalid or oversized/,
    );
  },
);
