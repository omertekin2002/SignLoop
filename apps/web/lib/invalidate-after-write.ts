import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * After a write, mark every query under the given keys stale and refetch the ones on screen.
 *
 * Use this instead of a bare `invalidateQueries` for workspace data. TanStack Query only restarts
 * a request in flight when its query already has data and is on screen. A search or page still
 * waiting for its first response, or a hover prefetch nobody observes yet, keeps its request, and
 * that answer from before the write is then stored as fresh. Cancelling first sends those again,
 * or leaves them stale for their next reader. Never rejects.
 */
export async function invalidateAfterWrite(
  client: QueryClient,
  ...queryKeys: QueryKey[]
): Promise<void> {
  await Promise.all(
    queryKeys.map((queryKey) => client.cancelQueries({ queryKey })),
  );
  await Promise.all(
    queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}
