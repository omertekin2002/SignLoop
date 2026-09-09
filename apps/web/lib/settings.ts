import { apiClient, getApiErrorMessage } from "@/lib/api-client";

// Shared shapes + error helper for the /api/settings endpoint, used by both the settings page
// and the dashboard (previously duplicated verbatim in each).

export type SettingsResponse = {
  primaryModel: string | null;
  personality: string;
  availablePrimaryModels: string[];
  /** OpenRouter models the user may pin even while primary models are available. */
  availableFallbackModels?: string[];
  availablePersonalities: string[];
};

export function getModelSelection(
  selectedModel: string,
  savedModel: string | null | undefined,
  availableModels: readonly string[],
): { model: string; hasChanges: boolean } {
  const model = availableModels.includes(selectedModel)
    ? selectedModel
    : savedModel && availableModels.includes(savedModel)
      ? savedModel
      : "";
  return { model, hasChanges: Boolean(model && model !== savedModel) };
}

export async function fetchSettings(options?: {
  refreshModels?: boolean;
}): Promise<SettingsResponse> {
  const suffix = options?.refreshModels ? "?refreshModels=1" : "";
  const response = await apiClient.get<SettingsResponse>(`/settings${suffix}`);
  return response.data;
}

export function getSettingsErrorMessage(error: unknown): string {
  return getApiErrorMessage(error, "Failed to save settings");
}
