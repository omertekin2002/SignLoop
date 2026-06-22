import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Tailwind classes for a contract risk badge (LOW/MEDIUM/HIGH). Pass { hover: true } to include
// hover-state variants (used where the badge sits in an interactive row).
export function getRiskColor(
  badge: string | null | undefined,
  options?: { hover?: boolean },
): string {
  const normalized = typeof badge === "string" ? badge.toLowerCase() : "";
  const hover = options?.hover ?? false;
  switch (normalized) {
    case "high":
      return hover
        ? "bg-destructive/15 text-destructive hover:bg-destructive/20"
        : "bg-destructive/15 text-destructive";
    case "medium":
      return hover
        ? "bg-amber-500/15 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
        : "bg-amber-500/15 text-amber-800 dark:text-amber-200";
    case "low":
      return hover
        ? "bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/20 dark:text-emerald-200"
        : "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    default:
      return hover ? "bg-muted text-muted-foreground hover:bg-muted" : "bg-muted text-muted-foreground";
  }
}
