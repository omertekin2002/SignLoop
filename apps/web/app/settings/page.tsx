"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/nextjs";
import { ArrowLeft, Loader2, Settings as SettingsIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { AxiosError } from "axios";
import { apiClient } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type SettingsResponse = {
  primaryModel: string | null;
  personality: string;
  availablePrimaryModels: string[];
  imageGenerationAvailable: boolean;
  modelsError: string | null;
  availablePersonalities: string[];
};

type SettingsErrorPayload = {
  error?: string;
};

const PERSONALITY_LABELS: Record<string, string> = {
  "bare-llm": "Bare LLM",
  "signloop-assistant": "SignLoop Assistant",
};

function getErrorMessage(error: unknown): string {
  const axiosError = error as AxiosError<SettingsErrorPayload>;
  return axiosError?.response?.data?.error || "Failed to save settings";
}

export default function SettingsPage() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { resolvedTheme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedPersonality, setSelectedPersonality] = useState<string>("");
  const [themeMounted, setThemeMounted] = useState(false);

  useEffect(() => {
    setThemeMounted(true);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const response = await apiClient.get<SettingsResponse>("/settings");
      return response.data;
    },
  });

  const availableModels = useMemo(
    () => data?.availablePrimaryModels ?? [],
    [data?.availablePrimaryModels],
  );
  const modelsError = data?.modelsError ?? null;
  const availablePersonalities = useMemo(
    () => data?.availablePersonalities ?? [],
    [data?.availablePersonalities],
  );
  const effectiveModel = useMemo(() => {
    if (selectedModel) return selectedModel;
    if (data?.primaryModel && availableModels.includes(data.primaryModel)) return data.primaryModel;
    return availableModels[0] ?? "";
  }, [availableModels, data?.primaryModel, selectedModel]);
  const effectivePersonality = useMemo(() => {
    if (selectedPersonality) return selectedPersonality;
    if (data?.personality) return data.personality;
    return availablePersonalities[1] ?? availablePersonalities[0] ?? "signloop-assistant";
  }, [availablePersonalities, data?.personality, selectedPersonality]);

  useEffect(() => {
    if (data?.primaryModel && availableModels.includes(data.primaryModel)) {
      setSelectedModel((current) => current || data.primaryModel || "");
      return;
    }
    const firstModel = availableModels[0];
    if (firstModel) {
      setSelectedModel((current) => current || firstModel);
    }
  }, [availableModels, data?.primaryModel]);

  useEffect(() => {
    if (data?.personality) {
      setSelectedPersonality((current) => current || data.personality || "");
      return;
    }
    const defaultPersonality = availablePersonalities[1] ?? availablePersonalities[0];
    if (defaultPersonality) {
      setSelectedPersonality((current) => current || defaultPersonality);
    }
  }, [availablePersonalities, data?.personality]);

  const saveModelMutation = useMutation({
    mutationFn: async (primaryModel: string) => {
      const response = await apiClient.put<{ primaryModel: string; updatedAt: string }>("/settings", {
        primaryModel,
      });
      return response.data;
    },
    onSuccess: (payload) => {
      toast.success(`Primary model saved: ${payload.primaryModel}`);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });

  const savePersonalityMutation = useMutation({
    mutationFn: async (personality: string) => {
      const response = await apiClient.put<{ personality: string; updatedAt: string }>("/settings", {
        personality,
      });
      return response.data;
    },
    onSuccess: (payload) => {
      toast.success(`Personality saved: ${payload.personality}`);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });

  const initialModel =
    data?.primaryModel && availableModels.includes(data.primaryModel)
      ? data.primaryModel
      : availableModels[0] ?? "";
  const hasModelChanges = Boolean(effectiveModel && effectiveModel !== initialModel);
  const initialPersonality =
    data?.personality ?? availablePersonalities[1] ?? availablePersonalities[0] ?? "signloop-assistant";
  const hasPersonalityChanges = Boolean(
    effectivePersonality && effectivePersonality !== initialPersonality
  );

  return (
    <div className="app-page">
      <header className="app-header">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-6 sm:px-6 lg:px-8">
          <h1 className="app-title">Settings</h1>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:block">Welcome, {user?.firstName}</span>
            <Button variant="outline" onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-6"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Dashboard
        </Link>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5" />
              Analysis Model
            </CardTitle>
            <CardDescription>
              Choose which primary model SignLoop should use first for analysis. If it fails, SignLoop
              automatically falls back to the configured OpenRouter model.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="text-sm text-muted-foreground">Loading settings...</div>
            ) : availableModels.length === 0 ? (
              <div className="space-y-1">
                <div className="text-sm text-destructive">No models are currently available.</div>
                {modelsError ? (
                  <div className="text-xs text-muted-foreground">{modelsError}</div>
                ) : null}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="primary-model">
                    Primary model
                  </label>
                  <Select value={effectiveModel} onValueChange={setSelectedModel}>
                    <SelectTrigger id="primary-model">
                      <SelectValue placeholder="Select a primary model" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {modelsError ? (
                    <p className="text-xs text-muted-foreground">
                      Live model refresh issue: {modelsError}
                    </p>
                  ) : null}
                </div>

                <div className="flex gap-2">
                  <Button
                    disabled={!hasModelChanges || saveModelMutation.isPending}
                    onClick={() => {
                      if (!effectiveModel) return;
                      saveModelMutation.mutate(effectiveModel);
                    }}
                  >
                    {saveModelMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "Save Settings"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={saveModelMutation.isPending}
                    onClick={() => setSelectedModel(initialModel)}
                  >
                    Reset
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Personality</CardTitle>
            <CardDescription>
              Choose whether chat replies should use SignLoop&apos;s legal-assistant persona or respond as a bare model.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="text-sm text-muted-foreground">Loading settings...</div>
            ) : availablePersonalities.length === 0 ? (
              <div className="text-sm text-destructive">No personality options are available.</div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="personality">
                    Chat personality
                  </label>
                  <Select value={effectivePersonality} onValueChange={setSelectedPersonality}>
                    <SelectTrigger id="personality">
                      <SelectValue placeholder="Select personality" />
                    </SelectTrigger>
                    <SelectContent>
                      {availablePersonalities.map((personalityOption) => (
                        <SelectItem key={personalityOption} value={personalityOption}>
                          {PERSONALITY_LABELS[personalityOption] ?? personalityOption}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-2">
                  <Button
                    disabled={!hasPersonalityChanges || savePersonalityMutation.isPending}
                    onClick={() => {
                      if (!effectivePersonality) return;
                      savePersonalityMutation.mutate(effectivePersonality);
                    }}
                  >
                    {savePersonalityMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "Save Settings"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={savePersonalityMutation.isPending}
                    onClick={() => setSelectedPersonality(initialPersonality)}
                  >
                    Reset
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>
              Control the visual theme for SignLoop.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 border border-[var(--surface-stroke)] bg-[var(--surface-elevated)] px-4 py-3">
              <div className="space-y-1">
                <Label htmlFor="dark-mode-toggle">Dark mode</Label>
                <p className="text-xs text-muted-foreground">
                  {themeMounted ? `Current theme: ${resolvedTheme === "dark" ? "Dark" : "Light"}` : "Loading theme..."}
                </p>
              </div>
              <Switch
                id="dark-mode-toggle"
                checked={themeMounted ? resolvedTheme === "dark" : false}
                onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                disabled={!themeMounted}
                aria-label="Toggle dark mode"
              />
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
