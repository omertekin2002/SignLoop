// Ported from SignLoop apps/web/lib/image-generation.ts at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import {
  createOpenAiCompatibleClient,
  type ProviderConfig,
  type LlmProvider,
} from "./llm-client";
export const MAX_IMAGE_BASE64_CHARACTERS = 8 * 1024 * 1024;

const IMAGE_GENERATION_TIMEOUT_MS = 150_000;

export type GeneratedImageReply = {
  message: string;
  model: string;
  provider: LlmProvider;
};

export async function generateImageReply(
  prompt: string,
  options: {
    providerConfig: ProviderConfig;
    model: string;
    signal?: AbortSignal;
    userId?: string | null;
  },
): Promise<GeneratedImageReply> {
  options.signal?.throwIfAborted();
  const primary = options.providerConfig.primary;
  if (!primary) throw new Error("Image generation requires a primary provider");
  const client = createOpenAiCompatibleClient(primary.baseURL, primary.apiKey, {
    timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
    publicServiceUrl: options.providerConfig.publicServiceUrl,
    appName: options.providerConfig.appName,
  });
  const response = await client.images.generate(
    {
      model: options.model,
      prompt,
      n: 1,
      output_format: "png",
      quality: "medium",
      size: "1024x1024",
      ...(options?.userId ? { user: options.userId } : {}),
    },
    { signal: options?.signal },
  );
  const base64 = response.data?.[0]?.b64_json?.trim();

  if (!base64) {
    throw new Error("The image endpoint returned no image data.");
  }

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
    model: options.model,
    provider: "primary-openai-compatible",
  };
}
