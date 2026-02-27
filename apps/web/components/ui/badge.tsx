import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-[var(--radius)] border-2 px-2.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-[0.12em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-[hsl(var(--border))] bg-[hsl(var(--accent)/0.22)] text-foreground hover:bg-[hsl(var(--accent)/0.32)]",
        secondary: "border-[hsl(var(--border))] bg-secondary text-secondary-foreground hover:bg-[hsl(var(--secondary)/0.9)]",
        destructive: "border-[hsl(var(--border))] bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border-[hsl(var(--border))] bg-[hsl(var(--card))] text-foreground",
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
