import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { workspaceListOptions } from "@/lib/use-workspace-list";
import {
  chatThreadOptions,
  contractDetailOptions,
  projectDetailOptions,
} from "@/lib/workspace-query-options";

export type NavigationDestination =
  | { kind: "list"; list: "contracts" | "projects" | "chat" }
  | { kind: "contract" | "project" | "thread"; id: string };

const lists = {
  contracts: ["contracts", "/contracts?standalone=true"],
  projects: ["projects", "/projects"],
  chat: ["chat-threads", "/chat/threads"],
} as const;

export async function prefetchNavigationDestination(
  client: QueryClient,
  destination: NavigationDestination,
) {
  if (destination.kind === "list") {
    const [key, path] = lists[destination.list];
    // A hover must not collapse a previously paginated list or refetch all its pages.
    // The destination's normal observer remains responsible for refreshing that view.
    if ((client.getQueryData<InfiniteData<unknown>>([key])?.pages.length ?? 0) > 1) return;
    if (client.getQueryCache().find({ queryKey: [key], exact: true })?.isActive()) return;
    await client.prefetchInfiniteQuery({
      ...workspaceListOptions(key, path),
      pages: 1,
      retry: false,
    });
    return;
  }

  const options = destination.kind === "contract"
    ? contractDetailOptions(destination.id)
    : destination.kind === "project"
      ? projectDetailOptions(destination.id)
      : chatThreadOptions(destination.id);
  if (client.getQueryCache().find({ queryKey: options.queryKey, exact: true })?.isActive()) return;
  // Just the canonical detail/recent-history read; no source, historical-analysis,
  // older-message, or subsequent project pages. Speculation never retries in the background.
  // Keep branches typed separately because their cache data shapes are intentionally distinct.
  if (destination.kind === "contract") {
    await client.prefetchQuery({ ...contractDetailOptions(destination.id), retry: false });
  } else if (destination.kind === "project") {
    await client.prefetchQuery({ ...projectDetailOptions(destination.id), retry: false });
  } else {
    await client.prefetchQuery({ ...chatThreadOptions(destination.id), retry: false });
  }
}

type IntentSource = "pointer" | "focus";

/** One latest candidate, a short dwell, and at most two speculative reads per mounted workspace. */
export function createNavigationPrefetcher(client: QueryClient) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: {
    key: string;
    destination: NavigationDestination;
    sources: Set<IntentSource>;
    ready: boolean;
  } | undefined;
  const running = new Set<string>();
  const keyFor = (destination: NavigationDestination) => destination.kind === "list"
    ? `list:${destination.list}`
    : `${destination.kind}:${destination.id}`;

  const clearPending = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const startReady = () => {
    if (disposed || !pending?.ready || running.size >= 2) return;
    const { key, destination } = pending;
    clearPending();
    running.add(key);
    void prefetchNavigationDestination(client, destination).catch(() => {
      // Navigation will perform its normal read/retry and show its own useful error UI.
    }).finally(() => {
      running.delete(key);
      startReady();
    });
  };

  return {
    intent(destination: NavigationDestination, source: IntentSource) {
      if (disposed) return;
      const key = keyFor(destination);
      if (pending?.key === key) {
        pending.sources.add(source);
        return;
      }
      clearPending();
      if (running.has(key)) return;
      pending = { key, destination, sources: new Set([source]), ready: false };
      timer = setTimeout(() => {
        if (pending) pending.ready = true;
        startReady();
      }, 120);
    },
    cancel(destination: NavigationDestination, source: IntentSource) {
      if (pending?.key !== keyFor(destination)) return;
      pending.sources.delete(source);
      if (!pending.sources.size) clearPending();
    },
    dispose() {
      disposed = true;
      clearPending();
      // Started reads belong to QueryClient: let navigation reuse them across unmount.
      // Providers cancels/clears the retired client when identity changes.
    },
  };
}
