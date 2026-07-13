import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@/lib/llm-client", () => ({
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

  it("forwards the prompt to gpt-image-2 and returns renderable markdown", async () => {
    mocks.generate.mockResolvedValue({
      data: [{ b64_json: "aW1hZ2U=" }],
    });
    const { generateImageReply } = await import("./image-generation");
    const signal = new AbortController().signal;

    await expect(
      generateImageReply("A signed contract on a desk", {
        signal,
        userId: "user-1",
      }),
    ).resolves.toEqual({
      message: "![Generated image](data:image/png;base64,aW1hZ2U=)",
      model: "gpt-image-2",
      provider: "primary-openai-compatible",
    });
    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://provider.example/v1",
      "secret",
      { timeoutMs: 150_000 },
    );
    expect(mocks.generate).toHaveBeenCalledWith(
      {
        model: "gpt-image-2",
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

    await expect(generateImageReply("Missing image")).rejects.toThrow(
      /no image data/i,
    );
  });
});
