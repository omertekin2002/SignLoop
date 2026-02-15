import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center border px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.11em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-[var(--surface-stroke)] bg-[hsl(var(--accent)/0.16)] text-foreground hover:bg-[hsl(var(--accent)/0.22)]",
        secondary: "border-[var(--surface-stroke-soft)] bg-secondary/65 text-secondary-foreground hover:bg-secondary/85",
        destructive: "border-destructive/50 bg-destructive/15 text-destructive hover:bg-destructive/22",
        outline: "border-[var(--surface-stroke)] bg-transparent text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
