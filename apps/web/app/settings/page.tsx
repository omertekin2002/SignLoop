"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/nextjs";
import { ArrowLeft, Loader2, Settings as SettingsIcon } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

type SettingsResponse = {
  primaryModel: string | null;
  availablePrimaryModels: string[];
};

export default function SettingsPage() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const [selectedModel, setSelectedModel] = useState<string>("");

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const response = await apiClient.get<SettingsResponse>("/settings");
      return response.data;
    },
  });

  const availableModels = data?.availablePrimaryModels ?? [];
  const effectiveModel = useMemo(() => {
    if (selectedModel) return selectedModel;
    if (data?.primaryModel) return data.primaryModel;
    return availableModels[0] ?? "";
  }, [availableModels, data?.primaryModel, selectedModel]);

  useEffect(() => {
    if (data?.primaryModel) {
      setSelectedModel((current) => current || data.primaryModel || "");
      return;
    }
    const firstModel = availableModels[0];
    if (firstModel) {
      setSelectedModel((current) => current || firstModel);
    }
  }, [availableModels, data?.primaryModel]);

  const saveMutation = useMutation({
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
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || "Failed to save settings");
    },
  });

  const initialModel = data?.primaryModel ?? availableModels[0] ?? "";
  const hasChanges = Boolean(effectiveModel && effectiveModel !== initialModel);

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-background/60 backdrop-blur border-b">
        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8 flex justify-between items-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">Welcome, {user?.firstName}</span>
            <Button variant="outline" onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
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
              <div className="text-sm text-destructive">No models are available.</div>
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
                </div>

                <div className="flex gap-2">
                  <Button
                    disabled={!hasChanges || saveMutation.isPending}
                    onClick={() => {
                      if (!effectiveModel) return;
                      saveMutation.mutate(effectiveModel);
                    }}
                  >
                    {saveMutation.isPending ? (
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
                    disabled={saveMutation.isPending}
                    onClick={() => setSelectedModel(initialModel)}
                  >
                    Reset
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
