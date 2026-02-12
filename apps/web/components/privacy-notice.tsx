"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const NOTICE_TEXT =
  "SignLoop works with Third-Party Large Language Model Providers, your data may be stored and processed for analysis. Providers may use your prompts, completions and responses to train new models. Providers may also publish your prompts, responses completions publicly. Use extreme discretion not to reveal sensitive information, we recommend completely redacting all personal information prior to using SignLoop";

export function PrivacyNotice() {
  const { isLoaded, isSignedIn } = useUser();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    setOpen(Boolean(isSignedIn));
  }, [isLoaded, isSignedIn]);

  const handleAcknowledge = () => {
    setOpen(false);
  };

  if (!isLoaded || !isSignedIn) return null;

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>SignLoop Privacy Notice</AlertDialogTitle>
          <AlertDialogDescription>{NOTICE_TEXT}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={handleAcknowledge}>I Understand and Accept</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
