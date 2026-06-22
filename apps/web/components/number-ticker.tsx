'use client';

import { type ComponentProps, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type NumberTickerProps = ComponentProps<"span"> & {
  value: number;
  direction?: "up" | "down";
  delay?: number;
  decimalPlaces?: number;
  startValue?: number;
  useGrouping?: boolean;
  start?: boolean;
};

export function NumberTicker({
  value,
  direction = "up",
  delay = 0,
  decimalPlaces = 0,
  startValue = 0,
  useGrouping = true,
  start = true,
  className,
  ...props
}: NumberTickerProps) {
  const [displayValue, setDisplayValue] = useState(direction === "down" ? value : startValue);

  useEffect(() => {
    if (!start || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mediaQuery.matches) {
      setDisplayValue(value);
      return;
    }

    const from = direction === "down" ? value : startValue;
    const to = direction === "down" ? startValue : value;
    const animationDuration = 1400;

    let frameId = 0;
    let timeoutId = 0;
    let animationStart = 0;

    const tick = (timestamp: number) => {
      if (!animationStart) {
        animationStart = timestamp;
      }

      const elapsed = timestamp - animationStart;
      const progress = Math.min(elapsed / animationDuration, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const nextValue = from + (to - from) * easedProgress;

      setDisplayValue(nextValue);

      if (progress < 1) {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    timeoutId = window.setTimeout(() => {
      setDisplayValue(from);
      frameId = window.requestAnimationFrame(tick);
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
      window.cancelAnimationFrame(frameId);
    };
  }, [start, delay, direction, startValue, value]);

  return (
    <span className={cn("tabular-nums", className)} {...props}>
      {displayValue.toLocaleString("en-US", {
        maximumFractionDigits: decimalPlaces,
        minimumFractionDigits: decimalPlaces,
        useGrouping,
      })}
    </span>
  );
}
