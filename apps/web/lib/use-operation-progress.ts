"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type OperationStage } from "@/lib/operation-progress";

export function isOperationCanceled(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "CanceledError")
  );
}

/** One operation per UI entry point; closing, leaving or changing identity invalidates callbacks. */
export function useOperationProgress(scope: string) {
  const queryClient = useQueryClient();
  const current = useRef<AbortController | null>(null);
  const [stage, setStage] = useState<OperationStage | null>(null);
  const cancel = useCallback(() => {
    current.current?.abort(
      new DOMException("Operation canceled", "AbortError"),
    );
    current.current = null;
    setStage(null);
  }, []);
  useEffect(() => cancel, [cancel, scope, queryClient]);
  const run = async <T>(
    initial: OperationStage,
    work: (options: {
      signal: AbortSignal;
      onStage: (stage: OperationStage) => void;
    }) => Promise<T>,
  ): Promise<T> => {
    if (current.current)
      throw new DOMException("Operation already running", "AbortError");
    const controller = new AbortController();
    current.current = controller;
    setStage(initial);
    try {
      const result = await work({
        signal: controller.signal,
        onStage: (next) => {
          if (current.current === controller && !controller.signal.aborted)
            setStage(next);
        },
      });
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      if (current.current === controller) {
        current.current = null;
        setStage(null);
      }
    }
  };
  return { stage, run, cancel };
}
