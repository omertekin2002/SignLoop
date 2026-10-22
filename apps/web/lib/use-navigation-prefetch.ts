"use client";

import { useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  createNavigationPrefetcher,
  type NavigationDestination,
} from "@/lib/navigation-prefetch";

export function useNavigationPrefetch() {
  const client = useQueryClient();
  const { loading, user } = useAuth();
  const ownerId = !loading ? user?.id : undefined;
  const prefetcher = useRef<ReturnType<typeof createNavigationPrefetcher> | null>(null);

  useLayoutEffect(() => {
    if (!ownerId) return;
    const current = createNavigationPrefetcher(client);
    prefetcher.current = current;
    return () => {
      current.dispose();
      prefetcher.current = null;
    };
  }, [client, ownerId]);

  return (destination: NavigationDestination) => ({
    onPointerEnter: (event: { pointerType: string }) => {
      if (ownerId && event.pointerType !== "touch") prefetcher.current?.intent(destination, "pointer");
    },
    onPointerLeave: () => prefetcher.current?.cancel(destination, "pointer"),
    onFocus: () => {
      if (ownerId) prefetcher.current?.intent(destination, "focus");
    },
    onBlur: () => prefetcher.current?.cancel(destination, "focus"),
  });
}
