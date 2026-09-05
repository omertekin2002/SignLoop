"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export function useWorkspaceList<T>(key: string, path: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: [key],
    initialPageParam: 0,
    enabled,
    queryFn: async ({ pageParam }) => (await apiClient.get<{
      data: T[]; total: number; limit: number; offset: number;
    }>(`${path}${path.includes("?") ? "&" : "?"}limit=50&offset=${pageParam}`)).data,
    getNextPageParam: (page) => page.offset + page.limit < page.total ? page.offset + page.limit : undefined,
  });
  const data = useMemo(() => query.data?.pages.flatMap((page) => page.data), [query.data]);
  return { ...query, data };
}
