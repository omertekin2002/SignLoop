"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiClient, getApiErrorMessage, type ApiError } from "@/lib/api-client";
import {
  confirmedRegion,
  MAX_JURISDICTION_LENGTH,
} from "@/lib/regional-comparisons";
import type { ContractDetail } from "@/lib/workspace-query-options";
import { JurisdictionSource } from "@/components/contract-source";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type JurisdictionUpdate = Pick<
  ContractDetail,
  "confirmedJurisdiction" | "jurisdictionConfirmedAt"
>;

/**
 * The contract's jurisdiction: the one the analysis proposes from the governing-law clause, with
 * its verified quotation, and the one the owner confirmed. Comparisons need a confirmation, and
 * only analyses run after it include them, so a report run without it offers a re-run.
 */
export function ContractJurisdiction({
  contractId,
  confirmed,
  report,
  onRerun,
  rerunPending,
}: {
  contractId: string;
  confirmed: string | null;
  /** The report on screen: its proposal and the jurisdiction it ran with. Null before analysis. */
  report: {
    proposed: string | null;
    ranWith: string | null;
    /** False for a historical report, which a re-run would not replace on screen. */
    isLatest: boolean;
  } | null;
  onRerun: () => void;
  rerunPending: boolean;
}) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const changeButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  const save = useMutation({
    mutationFn: async (jurisdiction: string | null) =>
      (
        await apiClient.patch<JurisdictionUpdate>(`/contracts/${contractId}`, {
          jurisdiction,
        })
      ).data,
    onSuccess: (saved, jurisdiction) => {
      queryClient.setQueryData<ContractDetail>(["contract", contractId], (current) =>
        current ? { ...current, ...saved } : current,
      );
      restoreFocus.current = true;
      setEditing(false);
      toast.success(
        jurisdiction === null
          ? "Jurisdiction cleared"
          : `Jurisdiction confirmed: ${saved.confirmedJurisdiction}`,
      );
    },
    onError: (error: ApiError) => {
      toast.error(getApiErrorMessage(error, "Could not save the jurisdiction"));
    },
  });

  const proposed = report?.proposed ?? null;
  const startEditing = () => {
    setDraft(confirmed ?? proposed ?? "");
    setEditing(true);
  };
  const stopEditing = () => {
    restoreFocus.current = true;
    setEditing(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = confirmedRegion(draft);
    if (!value) {
      toast.error("Enter a jurisdiction, such as a country or state.");
      return;
    }
    save.mutate(value);
  };
  // Return focus to the control that opened the form once it closes.
  const focusChangeButton = (button: HTMLButtonElement | null) => {
    changeButton.current = button;
    if (button && restoreFocus.current) {
      restoreFocus.current = false;
      button.focus();
    }
  };

  const needsRerun =
    confirmed !== null && report?.isLatest === true && report.ranWith !== confirmed;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jurisdiction</CardTitle>
        <CardDescription>
          Regional comparisons need a jurisdiction you confirm. They describe
          common practice there, not legal advice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {editing ? (
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={inputId}>Jurisdiction</Label>
              <Input
                id={inputId}
                value={draft}
                maxLength={MAX_JURISDICTION_LENGTH}
                // The form replaces the button the user just pressed to open it, so focus moves to
                // its field instead of falling back to the page; it never autofocuses on load.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                placeholder="For example: England and Wales"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    stopEditing();
                  }
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save jurisdiction
              </Button>
              {confirmed !== null && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() => save.mutate(null)}
                >
                  Clear jurisdiction
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={stopEditing}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            {confirmed !== null ? (
              <p>
                Confirmed jurisdiction:{" "}
                <span className="font-medium">{confirmed}</span>
              </p>
            ) : proposed !== null ? (
              <div>
                <p>
                  The governing-law clause names{" "}
                  <span className="font-medium">{proposed}</span>. Confirm it
                  if that is where this contract applies.
                </p>
                <JurisdictionSource />
              </div>
            ) : (
              <p className="text-muted-foreground">
                {report
                  ? "This analysis found no governing-law clause naming a jurisdiction."
                  : "The analysis will look for a governing-law clause naming a jurisdiction."}{" "}
                You can set one yourself.
              </p>
            )}
            {confirmed !== null && proposed !== null && proposed !== confirmed && (
              <p className="text-muted-foreground">
                The governing-law clause names {proposed}.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {confirmed === null && proposed !== null && (
                <Button
                  disabled={save.isPending}
                  onClick={() => save.mutate(proposed)}
                >
                  {save.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Confirm {proposed}
                </Button>
              )}
              <Button
                ref={focusChangeButton}
                variant="outline"
                disabled={save.isPending}
                onClick={startEditing}
              >
                {confirmed !== null || proposed !== null
                  ? "Change jurisdiction"
                  : "Set jurisdiction"}
              </Button>
            </div>
            {needsRerun && (
              <div role="status" className="rounded-card border px-4 py-3">
                <p>
                  {report?.ranWith
                    ? `This analysis compared terms with ${report.ranWith}.`
                    : "This analysis ran before a jurisdiction was confirmed, so it has no regional comparisons."}{" "}
                  Re-run it to compare terms with typical practice in{" "}
                  {confirmed}.
                </p>
                <Button
                  className="mt-3"
                  variant="outline"
                  disabled={rerunPending}
                  onClick={onRerun}
                >
                  {rerunPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Re-run analysis with {confirmed}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
