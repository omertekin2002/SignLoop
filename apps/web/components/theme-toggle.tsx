"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

const subscribeNoop = () => () => {};

// The resolved theme only exists after next-themes reads storage on the client; rendering it on the
// server would mismatch on hydration, so callers show a neutral state until this returns true.
export function useIsClient() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

// Sidebar row that flips between light and dark. The full light/dark/system choice lives in Settings.
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isClient = useIsClient();
  const isLight = isClient && resolvedTheme === "light";
  const label = isLight ? "Dark mode" : "Light mode";

  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={`Switch to ${label.toLowerCase()}`}
      className="w-full justify-start text-muted-foreground hover:text-foreground"
      onClick={() => setTheme(isLight ? "dark" : "light")}
      disabled={!isClient}
    >
      {isLight ? <Moon className="mr-3 h-4 w-4" /> : <Sun className="mr-3 h-4 w-4" />}
      <span>{label}</span>
    </Button>
  );
}
