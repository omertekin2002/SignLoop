"use client";

import { useMemo } from "react";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

const DEFAULT_PAGE_SIZE = 50;

/** Extra query parameters a list request carries, such as the contracts list's filters; empty values are left out. */
export type WorkspaceListFilters = Record<string, string | null | undefined>;

/**
 * A search term and any filters join the key under the list's prefix, so invalidating `[key]`
 * refreshes searches and filtered lists too. A smaller page size joins the key as well, so lists
 * paged differently never share pages.
 */
export function workspaceListOptions<T>(
  key: string,
  path: string,
  search = "",
  filters: WorkspaceListFilters = {},
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const params: Record<string, string> = {};
  if (search) params.q = search;
  for (const [name, value] of Object.entries(filters)) {
    if (value) params[name] = value;
  }
  const searchParam = Object.entries(params)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}&`)
    .join("");
  const keyParams =
    pageSize === DEFAULT_PAGE_SIZE ? params : { ...params, limit: String(pageSize) };
  return infiniteQueryOptions({
    queryKey: Object.keys(keyParams).length ? [key, keyParams] : [key],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      (
        await apiClient.get<{
          data: T[];
          total: number;
          limit: number;
          offset: number;
        }>(
          `${path}${path.includes("?") ? "&" : "?"}${searchParam}limit=${pageSize}&offset=${pageParam}`,
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
  filters: WorkspaceListFilters = {},
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const query = useInfiniteQuery({
    ...workspaceListOptions<T>(key, path, search, filters, pageSize),
    enabled,
  });
  const data = useMemo(
    () => query.data?.pages.flatMap((page) => page.data),
    [query.data],
  );
  const total = query.data?.pages.at(-1)?.total;
  return { ...query, data, total };
}
