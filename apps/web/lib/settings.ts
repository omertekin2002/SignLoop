import { apiClient, getApiErrorMessage } from "@/lib/api-client";

// Shared shapes + error helper for the /api/settings endpoint, used by both the settings page
// and the dashboard (previously duplicated verbatim in each).

export type SettingsResponse = {
  primaryModel: string | null;
  personality: string;
  availablePrimaryModels: string[];
  availablePersonalities: string[];
};

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
