import {
  createOpenAiCompatibleClient,
  PRIMARY_LLM_API_KEY,
  PRIMARY_LLM_BASE_URL,
  type LlmProvider,
} from "@/lib/llm-client";
import { IMAGE_GENERATION_MODEL } from "@/lib/model-settings";

const IMAGE_GENERATION_TIMEOUT_MS = 150_000;

export type GeneratedImageReply = {
  message: string;
  model: typeof IMAGE_GENERATION_MODEL;
  provider: LlmProvider;
};

export async function generateImageReply(
  prompt: string,
  options?: { signal?: AbortSignal; userId?: string | null },
): Promise<GeneratedImageReply> {
  const client = createOpenAiCompatibleClient(
    PRIMARY_LLM_BASE_URL,
    PRIMARY_LLM_API_KEY,
    { timeoutMs: IMAGE_GENERATION_TIMEOUT_MS },
  );
  const response = await client.images.generate(
    {
      model: IMAGE_GENERATION_MODEL,
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

  return {
    message: `![Generated image](data:image/png;base64,${base64})`,
    model: IMAGE_GENERATION_MODEL,
    provider: "primary-openai-compatible",
  };
}
