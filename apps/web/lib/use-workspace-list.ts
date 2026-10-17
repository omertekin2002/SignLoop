"use client";

import { useMemo } from "react";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export function workspaceListOptions<T>(key: string, path: string) {
  return infiniteQueryOptions({
    queryKey: [key],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      (
        await apiClient.get<{
          data: T[];
          total: number;
          limit: number;
          offset: number;
        }>(
          `${path}${path.includes("?") ? "&" : "?"}limit=50&offset=${pageParam}`,
          { signal },
        )
      ).data,
    getNextPageParam: (page) =>
      page.offset + page.limit < page.total
        ? page.offset + page.limit
        : undefined,
  });
}

/** Replace the paginated view atomically after one head-page read, keeping stale pages visible until then. */
export async function refreshWorkspaceList(
  client: QueryClient,
  key: string,
  path: string,
) {
  await client.cancelQueries({ queryKey: [key], exact: true });
  return client.fetchInfiniteQuery({
    ...workspaceListOptions(key, path),
    pages: 1,
    staleTime: 0,
  });
}

export function useWorkspaceList<T>(
  key: string,
  path: string,
  enabled: boolean,
) {
  const query = useInfiniteQuery({
    ...workspaceListOptions<T>(key, path),
    enabled,
  });
  const data = useMemo(
    () => query.data?.pages.flatMap((page) => page.data),
    [query.data],
  );
  return { ...query, data };
}
