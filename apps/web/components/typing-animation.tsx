'use client';

import { useEffect, useEffectEvent, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const CURSOR_BY_STYLE = {
  block: "▌",
  line: "|",
  underscore: "_",
} as const;

type CursorStyle = keyof typeof CURSOR_BY_STYLE;

type TypingAnimationProps = {
  text: string;
  start?: boolean;
  initialDelay?: number;
  typeSpeed?: number;
  showCursor?: boolean;
  persistCursor?: boolean;
  cursorStyle?: CursorStyle;
  className?: string;
  cursorClassName?: string;
  onComplete?: () => void;
};

export function TypingAnimation({
  text,
  start = true,
  initialDelay = 0,
  typeSpeed = 100,
  showCursor = true,
  persistCursor = true,
  cursorStyle = "line",
  className,
  cursorClassName,
  onComplete,
}: TypingAnimationProps) {
  const [visibleCount, setVisibleCount] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const hasCompletedRef = useRef(false);

  const handleComplete = useEffectEvent(() => {
    onComplete?.();
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);

    return () => {
      mediaQuery.removeEventListener("change", updatePreference);
    };
  }, []);

  useEffect(() => {
    if (!start) {
      setVisibleCount(0);
      hasCompletedRef.current = false;
      return;
    }

    if (prefersReducedMotion) {
      setVisibleCount(text.length);

      if (!hasCompletedRef.current) {
        hasCompletedRef.current = true;
        handleComplete();
      }

      return;
    }

    if (visibleCount >= text.length) {
      if (!hasCompletedRef.current) {
        hasCompletedRef.current = true;
        handleComplete();
      }

      return;
    }

    const timeoutId = window.setTimeout(() => {
      setVisibleCount((currentCount) => Math.min(currentCount + 1, text.length));
    }, visibleCount === 0 ? initialDelay : typeSpeed);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [handleComplete, initialDelay, prefersReducedMotion, start, text, typeSpeed, visibleCount]);

  const shouldShowCursor = showCursor && start && (visibleCount < text.length || persistCursor);

  return (
    <span className={cn("inline", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {text.slice(0, visibleCount)}
        {shouldShowCursor ? (
          <span className={cn("typing-cursor", cursorClassName)}>{CURSOR_BY_STYLE[cursorStyle]}</span>
        ) : null}
      </span>
    </span>
  );
}
