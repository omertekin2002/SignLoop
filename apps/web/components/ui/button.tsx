import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none border border-transparent text-[0.8rem] font-bold uppercase tracking-[0.11em] leading-none ring-offset-background transition-[transform,box-shadow,background-color,border-color,color] duration-200 ease-out enabled:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:transform-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] border-[rgba(217,119,87,0.75)] shadow-[var(--button-accent-shadow)] enabled:hover:bg-[#c96a4d] enabled:hover:border-[rgba(201,106,77,0.85)] enabled:hover:shadow-[var(--button-accent-shadow-hover)]",
        destructive:
          "bg-destructive text-destructive-foreground border-destructive shadow-[0_10px_24px_rgba(127,29,29,0.25)] enabled:hover:bg-destructive/90 enabled:hover:shadow-[0_14px_30px_rgba(127,29,29,0.35)]",
        outline:
          "border-[var(--card-border-strong)] bg-[var(--card-surface)] text-foreground shadow-[var(--card-shadow)] backdrop-blur-sm enabled:hover:bg-[rgba(217,119,87,0.12)] enabled:hover:border-[rgba(217,119,87,0.72)] enabled:hover:shadow-[var(--button-accent-shadow)]",
        secondary:
          "border-[var(--card-border-strong)] bg-secondary/75 text-secondary-foreground shadow-[var(--card-shadow)] enabled:hover:bg-secondary enabled:hover:border-[var(--glass-border)]",
        ghost:
          "border-transparent bg-transparent text-foreground shadow-none enabled:hover:bg-[rgba(20,20,19,0.08)] dark:enabled:hover:bg-[rgba(250,249,245,0.12)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-12 px-5",
        sm: "h-10 px-4 text-[0.75rem]",
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
