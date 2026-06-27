"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
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
import { cn } from "@/lib/utils";

const NOTICE_TEXT =
  "SignLoop works with Third-Party Large Language Model Providers, your data may be stored and processed for analysis. Providers may use your prompts, completions and responses to train new models. Providers may also publish your prompts, responses completions publicly. Use extreme discretion not to reveal sensitive information, we recommend completely redacting all personal information prior to using SignLoop";

const ackStorageKey = (userId: string) => `signloop:privacy-ack:${userId}`;

export function PrivacyNotice() {
  const { isLoaded, isSignedIn, user } = useUser();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isLandingPage = pathname === "/";

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) {
      setOpen(false);
      return;
    }

    // Only show the notice until this user has acknowledged it; the acknowledgement is persisted in
    // localStorage so it doesn't reappear on every reload / new tab.
    try {
      setOpen(window.localStorage.getItem(ackStorageKey(user.id)) !== "1");
    } catch {
      // localStorage unavailable (e.g. privacy mode) — fail open and show the notice.
      setOpen(true);
    }
  }, [isLoaded, isSignedIn, user]);

  const handleAcknowledge = () => {
    if (user) {
      try {
        window.localStorage.setItem(ackStorageKey(user.id), "1");
      } catch {
        // Ignore persistence failures; closing the dialog for this session is still correct.
      }
    }
    setOpen(false);
  };

  if (!isLoaded || !isSignedIn) return null;

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className={cn(isLandingPage && "light")}>
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
