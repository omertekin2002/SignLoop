"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/nextjs";
import { ArrowLeft, Loader2, Settings as SettingsIcon } from "lucide-react";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import {
  fetchSettings,
  getModelSelection,
  getSettingsErrorMessage,
} from "@/lib/settings";
import { DEFAULT_PERSONALITY_MODE } from "@/lib/personality-settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { useIsClient } from "@/components/theme-toggle";

const PERSONALITY_LABELS: Record<string, string> = {
  "bare-llm": "Bare LLM",
  "signloop-assistant": "SignLoop Assistant",
};

export default function SettingsPage() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedPersonality, setSelectedPersonality] = useState<string>("");
  const [modelSelectOpen, setModelSelectOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const isClient = useIsClient();

  const { data, isLoading, isFetching, isLoadingError, error, refetch } = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => fetchSettings({ signal }),
    staleTime: 60_000,
  });

  const handleModelSelectOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setModelSelectOpen(false);
      return;
    }
    if (isFetching) return;

    void refetch().then((result) => {
      if (result.isSuccess) {
        setModelSelectOpen(true);
        return;
      }

      toast.error(getApiErrorMessage(result.error, "Failed to refresh models"));
    });
  };

  const fallbackModels = useMemo(
    () => data?.availableFallbackModels ?? [],
    [data?.availableFallbackModels],
  );
  const availableModels = useMemo(
    () => [...(data?.availablePrimaryModels ?? []), ...fallbackModels],
    [data?.availablePrimaryModels, fallbackModels],
  );
  const availablePersonalities = useMemo(
    () => data?.availablePersonalities ?? [],
    [data?.availablePersonalities],
  );
  const { model: effectiveModel, hasChanges: hasModelChanges } =
    getModelSelection(selectedModel, data?.primaryModel, availableModels);
  const effectivePersonality = useMemo(() => {
    if (selectedPersonality) return selectedPersonality;
    if (data?.personality) return data.personality;
    return DEFAULT_PERSONALITY_MODE;
  }, [data?.personality, selectedPersonality]);

  // No state-sync effects here: selectedModel/selectedPersonality stay "" until the user picks,
  // and the effective* memos above fall back to the fetched values — pre-seeding the state with
  // the same fallback was redundant and pinned the display to a stale value across refetches.
  const saveModelMutation = useMutation({
    mutationFn: async (primaryModel: string) => {
      const response = await apiClient.put<{
        primaryModel: string;
        updatedAt: string;
      }>("/settings", {
        primaryModel,
      });
      return response.data;
    },
    onSuccess: (payload) => {
      toast.success(`Primary model saved: ${payload.primaryModel}`);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: unknown) => {
      toast.error(getSettingsErrorMessage(error));
    },
  });

  const savePersonalityMutation = useMutation({
    mutationFn: async (personality: string) => {
      const response = await apiClient.put<{
        personality: string;
        updatedAt: string;
      }>("/settings", {
        personality,
      });
      return response.data;
    },
    onSuccess: (payload) => {
      toast.success(`Personality saved: ${payload.personality}`);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: unknown) => {
      toast.error(getSettingsErrorMessage(error));
    },
  });

  const initialPersonality = data?.personality ?? DEFAULT_PERSONALITY_MODE;
  const hasPersonalityChanges = Boolean(
    effectivePersonality && effectivePersonality !== initialPersonality,
  );

  return (
    <div className="app-page">
      <header className="app-header">
        <div className="mx-auto flex max-w-4xl items-end justify-between gap-4 px-4 pb-6 pt-10 sm:px-6 lg:px-8">
          <div className="space-y-3">
            <p className="app-eyebrow">Workspace</p>
            <h1 className="app-title">Settings</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-muted-foreground sm:block">
              Welcome, {user?.firstName}
            </span>
            <Button variant="outline" onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 pb-16 pt-2 sm:px-6 lg:px-8">
        <Link
          href="/dashboard"
          className="mb-6 inline-flex items-center text-nav-label font-semibold uppercase text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Dashboard
        </Link>

        {isLoadingError ? (
          <Card role="alert">
            <CardHeader>
              <CardTitle>Unable to load settings</CardTitle>
              <CardDescription>
                {getApiErrorMessage(error, "Check your connection and try again.")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
                {isFetching ? "Loading…" : "Try again"}
              </Button>
            </CardContent>
          </Card>
        ) : <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5" />
              Analysis Model
            </CardTitle>
            <CardDescription>
              Choose which model SignLoop should use first for analysis and
              chat. If a primary model fails, SignLoop falls back to OpenRouter
              automatically. Pick an OpenRouter model to skip the primary
              endpoint entirely.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="text-sm text-muted-foreground">
                Loading settings...
              </div>
            ) : availableModels.length === 0 ? (
              <div className="space-y-2">
                <label
                  className="text-sm text-foreground"
                  htmlFor="primary-model"
                >
                  Primary model
                </label>
                <Select value="openrouter" disabled>
                  <SelectTrigger id="primary-model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
                  {isFetching ? "Loading…" : "Reload model options"}
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label
                    className="text-sm text-foreground"
                    htmlFor="primary-model"
                  >
                    Primary model
                  </label>
                  <Select
                    value={effectiveModel}
                    open={modelSelectOpen}
                    onOpenChange={handleModelSelectOpenChange}
                    onValueChange={setSelectedModel}
                    disabled={isFetching || saveModelMutation.isPending}
                  >
                    <SelectTrigger id="primary-model">
                      <SelectValue placeholder="Automatic fallback" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((model) => (
                        <SelectItem key={model} value={model}>
                          {fallbackModels.includes(model)
                            ? `${model} (OpenRouter)`
                            : model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isFetching ? (
                    <p
                      className="text-xs text-muted-foreground"
                      aria-live="polite"
                    >
                      Refreshing available models...
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
                    onClick={() => setSelectedModel("")}
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
              Choose whether chat replies should use SignLoop&apos;s
              legal-assistant persona or respond as a bare model.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="text-sm text-muted-foreground">
                Loading settings...
              </div>
            ) : availablePersonalities.length === 0 ? (
              <div className="text-sm text-destructive">
                No personality options are available.
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label
                    className="text-sm text-foreground"
                    htmlFor="personality"
                  >
                    Chat personality
                  </label>
                  <Select
                    value={effectivePersonality}
                    onValueChange={setSelectedPersonality}
                  >
                    <SelectTrigger id="personality">
                      <SelectValue placeholder="Select personality" />
                    </SelectTrigger>
                    <SelectContent>
                      {availablePersonalities.map((personalityOption) => (
                        <SelectItem
                          key={personalityOption}
                          value={personalityOption}
                        >
                          {PERSONALITY_LABELS[personalityOption] ??
                            personalityOption}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-2">
                  <Button
                    disabled={
                      !hasPersonalityChanges ||
                      savePersonalityMutation.isPending
                    }
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

        </>}

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>
              Choose a light or dark canvas, or follow your system setting.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <label className="text-sm text-foreground" htmlFor="theme">
                Theme
              </label>
              <Select
                value={isClient ? theme : undefined}
                onValueChange={setTheme}
                disabled={!isClient}
              >
                <SelectTrigger id="theme">
                  <SelectValue placeholder="Loading theme..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
