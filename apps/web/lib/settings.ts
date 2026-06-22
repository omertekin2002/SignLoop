import type { AxiosError } from "axios";

// Shared shapes + error helper for the /api/settings endpoint, used by both the settings page
// and the dashboard (previously duplicated verbatim in each).

export type SettingsResponse = {
  primaryModel: string | null;
  personality: string;
  availablePrimaryModels: string[];
  modelsError: string | null;
  availablePersonalities: string[];
};

export type SettingsErrorPayload = {
  error?: string;
};

export function getSettingsErrorMessage(error: unknown): string {
  const axiosError = error as AxiosError<SettingsErrorPayload>;
  return axiosError?.response?.data?.error || "Failed to save settings";
}
