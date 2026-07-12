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
import {
  acknowledgePrivacyConsent,
  hasPrivacyConsent,
} from "@/lib/privacy-consent";

const NOTICE_TEXT =
  "SignLoop works with Third-Party Large Language Model Providers, your data may be stored and processed for analysis. Providers may use your prompts, completions and responses to train new models. Providers may also publish your prompts, responses completions publicly. Use extreme discretion not to reveal sensitive information, we recommend completely redacting all personal information prior to using SignLoop";

export function PrivacyNotice() {
  const { isLoaded, user } = useUser();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isLandingPage = pathname === "/";
  const isAuthPage =
    pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");

  useEffect(() => {
    if (!isLoaded || isAuthPage) {
      setOpen(false);
      return;
    }

    setOpen(!hasPrivacyConsent(user?.id));
  }, [isAuthPage, isLoaded, user?.id]);

  const handleAcknowledge = () => {
    acknowledgePrivacyConsent(user?.id);
    setOpen(false);
  };

  if (!isLoaded) return null;

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className={cn(isLandingPage && "light")}>
        <AlertDialogHeader>
          <AlertDialogTitle>SignLoop Privacy Notice</AlertDialogTitle>
          <AlertDialogDescription>{NOTICE_TEXT}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={handleAcknowledge}>
            I Understand and Accept
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
