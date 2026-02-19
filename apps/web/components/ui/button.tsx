import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] border text-[0.78rem] font-semibold uppercase tracking-[0.12em] leading-none ring-offset-background transition-[transform,box-shadow,background-color,border-color,color,opacity] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:transform-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] shadow-[var(--button-accent-shadow)] enabled:hover:-translate-y-0.5 enabled:hover:bg-[hsl(var(--accent)/0.9)] enabled:hover:shadow-[var(--button-accent-shadow-hover)]",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground shadow-[0_10px_22px_-12px_rgba(127,29,29,0.75)] enabled:hover:-translate-y-0.5 enabled:hover:bg-destructive/90 enabled:hover:shadow-[0_16px_28px_-14px_rgba(127,29,29,0.85)]",
        outline:
          "border-[var(--surface-stroke)] bg-[var(--surface-elevated)] text-foreground shadow-[0_8px_18px_-12px_rgba(18,24,37,0.45)] enabled:hover:-translate-y-0.5 enabled:hover:border-[hsl(var(--accent)/0.52)] enabled:hover:bg-[hsl(var(--accent)/0.1)]",
        secondary:
          "border-[var(--surface-stroke-soft)] bg-secondary/85 text-secondary-foreground shadow-[0_8px_18px_-12px_rgba(18,24,37,0.38)] enabled:hover:-translate-y-0.5 enabled:hover:border-[var(--surface-stroke)] enabled:hover:bg-secondary",
        ghost:
          "border-transparent bg-transparent text-foreground shadow-none enabled:hover:bg-[var(--surface-inset)] enabled:hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-3.5 text-[0.72rem]",
        lg: "h-12 px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
