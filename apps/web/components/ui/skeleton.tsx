import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-none border border-[var(--surface-stroke-soft)] bg-[linear-gradient(110deg,var(--surface-base)_8%,var(--surface-elevated)_18%,var(--surface-base)_33%)] bg-[length:200%_100%]",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
