"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type OperationStage } from "@/lib/operation-progress";
import { withAbort } from "@/lib/bounded-response";

export function isOperationCanceled(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "CanceledError")
  );
}

/** Cleanup invalidates UI callbacks; persisted analysis can keep its request running. */
export function useOperationProgress(
  scope: string,
  { abortOnUnmount = true }: { abortOnUnmount?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const current = useRef<AbortController | null>(null);
  const [stage, setStage] = useState<OperationStage | null>(null);
  const detach = useCallback(() => {
    current.current = null;
    setStage(null);
  }, []);
  const cancel = useCallback(() => {
    current.current?.abort(
      new DOMException("Operation canceled", "AbortError"),
    );
    detach();
  }, [detach]);
  useEffect(
    () => (abortOnUnmount ? cancel : detach),
    [abortOnUnmount, cancel, detach, scope, queryClient],
  );
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
    const throwIfInactive = () => {
      controller.signal.throwIfAborted();
      if (current.current !== controller)
        throw new DOMException("Operation view closed", "AbortError");
    };
    try {
      const result = await withAbort(work({
        signal: controller.signal,
        onStage: (next) => {
          if (current.current === controller && !controller.signal.aborted)
            setStage(next);
        },
      }), controller.signal);
      throwIfInactive();
      return result;
    } catch (error) {
      throwIfInactive();
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
