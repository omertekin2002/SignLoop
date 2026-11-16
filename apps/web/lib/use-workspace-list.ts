"use client";

import { useMemo } from "react";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

/** A search term joins the key under the list's prefix, so invalidating `[key]` refreshes searches too. */
export function workspaceListOptions<T>(
  key: string,
  path: string,
  search = "",
) {
  const searchParam = search ? `q=${encodeURIComponent(search)}&` : "";
  return infiniteQueryOptions({
    queryKey: search ? [key, { q: search }] : [key],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      (
        await apiClient.get<{
          data: T[];
          total: number;
          limit: number;
          offset: number;
        }>(
          `${path}${path.includes("?") ? "&" : "?"}${searchParam}limit=50&offset=${pageParam}`,
          { signal },
        )
      ).data,
    getNextPageParam: (page) =>
      page.offset + page.limit < page.total
        ? page.offset + page.limit
        : undefined,
  });
}

/**
 * Replace the paginated view atomically after one head-page read, keeping stale pages visible until then.
 * Searches under the same prefix are invalidated too, so an open search never shows a stale list.
 */
export async function refreshWorkspaceList(
  client: QueryClient,
  key: string,
  path: string,
) {
  // Cancel searches too, not only the list. Invalidating a search that is still waiting for its
  // first response reuses that request, and its answer from before the change would count as fresh.
  await client.cancelQueries({ queryKey: [key] });
  const [result] = await Promise.all([
    client.fetchInfiniteQuery({
      ...workspaceListOptions(key, path),
      pages: 1,
      staleTime: 0,
    }),
    client.invalidateQueries({
      queryKey: [key],
      predicate: (query) => query.queryKey.length > 1,
    }),
  ]);
  return result;
}

export function useWorkspaceList<T>(
  key: string,
  path: string,
  enabled: boolean,
  search = "",
) {
  const query = useInfiniteQuery({
    ...workspaceListOptions<T>(key, path, search),
    enabled,
  });
  const data = useMemo(
    () => query.data?.pages.flatMap((page) => page.data),
    [query.data],
  );
  const total = query.data?.pages.at(-1)?.total;
  return { ...query, data, total };
}
