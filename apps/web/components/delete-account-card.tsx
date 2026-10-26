"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ACCOUNT_DELETION_CONFIRMATION } from "@/lib/account-deletion";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const REMOVED_DATA = [
  "contracts, their uploaded files, and analyses",
  "projects and their reference documents",
  "saved chats, with their images and files",
  "your settings",
  "your SignLoop sign-in",
];

/** Settings' danger section: deletes the account behind a typed confirmation. */
export function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const deleteAccount = useMutation({
    mutationFn: () =>
      apiClient.delete("/account", {
        data: { confirm: ACCOUNT_DELETION_CONFIRMATION },
      }),
    // The route ended the session; a full navigation also drops every cached workspace query.
    onSuccess: () => window.location.assign("/"),
    onError: (error: unknown) =>
      toast.error(getApiErrorMessage(error, "Failed to delete your account")),
  });
  const busy = deleteAccount.isPending || deleteAccount.isSuccess;
  const confirmed = confirmation.trim() === ACCOUNT_DELETION_CONFIRMATION;

  const handleOpenChange = (nextOpen: boolean) => {
    if (busy) return;
    setOpen(nextOpen);
    if (!nextOpen) setConfirmation("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Permanently delete your account and everything in it. This cannot be
          undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={handleOpenChange}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Delete account</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (confirmed && !busy) deleteAccount.mutate();
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2">
                    <p>This immediately and permanently deletes:</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {REMOVED_DATA.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <p>
                      Stored files are erased by a cleanup job within a day.
                      This cannot be undone.
                    </p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-2">
                <Label htmlFor="delete-account-confirmation">
                  Type {ACCOUNT_DELETION_CONFIRMATION} to confirm
                </Label>
                <Input
                  id="delete-account-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={busy}>
                  Cancel
                </AlertDialogCancel>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={!confirmed || busy}
                >
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    "Delete account"
                  )}
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
