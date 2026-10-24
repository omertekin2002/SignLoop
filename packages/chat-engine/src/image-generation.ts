import { createOpenAiCompatibleClient } from "./openai-client";

const IMAGE_GENERATION_TIMEOUT_MS = 150_000;
export const MAX_IMAGE_BASE64_CHARACTERS = 8 * 1024 * 1024;

/** An OpenAI-compatible image endpoint. */
export type ImageGenerationConfig = {
  baseURL: string;
  apiKey?: string;
  model: string;
  /** Provider label for replies and failure logs; defaults to "primary-openai-compatible". */
  provider?: string;
  referer?: string;
  appName?: string;
};

export type GeneratedImageReply = {
  message: string;
  model: string;
  provider: string;
};

export async function generateImageReply(
  prompt: string,
  options: {
    config: ImageGenerationConfig;
    signal?: AbortSignal;
    /** Passed through to the image endpoint's `user` field for abuse attribution. */
    userId?: string | null;
  },
): Promise<GeneratedImageReply> {
  const { config } = options;
  const client = createOpenAiCompatibleClient(config.baseURL, config.apiKey, {
    timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
    referer: config.referer,
    appName: config.appName,
  });
  const response = await client.images.generate(
    {
      model: config.model,
      prompt,
      n: 1,
      output_format: "png",
      quality: "medium",
      size: "1024x1024",
      ...(options.userId ? { user: options.userId } : {}),
    },
    { signal: options.signal },
  );
  const base64 = response.data?.[0]?.b64_json?.trim();

  if (!base64) {
    throw new Error("The image endpoint returned no image data.");
  }

  // The payload is embedded in markdown and persisted as an attachment, so it must be plain base64.
  if (
    base64.length > MAX_IMAGE_BASE64_CHARACTERS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  ) {
    throw new Error(
      "The image endpoint returned invalid or oversized image data.",
    );
  }

  return {
    message: `![Generated image](data:image/png;base64,${base64})`,
    model: config.model,
    provider: config.provider ?? "primary-openai-compatible",
  };
}
