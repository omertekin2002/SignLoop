import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import {
  refreshWorkspaceList,
  workspaceListOptions,
} from "./use-workspace-list";

afterEach(() => vi.restoreAllMocks());

describe("workspace list head refresh", () => {
  it("replaces ten cached pages atomically with one read, then resumes pagination at the correct offset", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    const get = vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
      const offset = Number(
        new URL(String(url), "https://app.test").searchParams.get("offset"),
      );
      return {
        data: {
          data: [{ id: `thread-${offset}` }],
          offset,
          limit: 50,
          total: 500,
        },
      };
    });
    const observer = new InfiniteQueryObserver(
      client,
      workspaceListOptions<{ id: string }>("chat-threads", "/chat/threads"),
    );
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      for (let index = 1; index < 10; index++) await observer.fetchNextPage();
      expect(observer.getCurrentResult().data?.pages).toHaveLength(10);
      get.mockClear();
      let finish!: (value: Awaited<ReturnType<typeof apiClient.get>>) => void;
      get.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const refresh = refreshWorkspaceList(
        client,
        "chat-threads",
        "/chat/threads",
      );
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
      expect(observer.getCurrentResult().data?.pages).toHaveLength(10);
      finish({
        data: {
          data: [{ id: "just-updated-thread" }],
          offset: 0,
          limit: 50,
          total: 500,
        },
      });
      await refresh;
      expect(get.mock.calls[0]?.[0]).toBe("/chat/threads?limit=50&offset=0");
      expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
      expect(observer.getCurrentResult().data?.pages[0]?.data).toEqual([
        { id: "just-updated-thread" },
      ]);
      await observer.fetchNextPage();
      expect(get.mock.calls[1]?.[0]).toBe("/chat/threads?limit=50&offset=50");
      expect(observer.getCurrentResult().data?.pageParams).toEqual([0, 50]);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});

describe("workspace list search", () => {
  it("keys a search under the list's prefix and sends it, encoded, with each page", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const get = vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
      const offset = Number(
        new URL(String(url), "https://app.test").searchParams.get("offset"),
      );
      return {
        data: {
          data: [{ id: `contract-${offset}` }],
          offset,
          limit: 50,
          total: 60,
        },
      };
    });
    const options = workspaceListOptions<{ id: string }>(
      "contracts",
      "/contracts?standalone=true",
      "50% & lease",
    );
    expect(options.queryKey).toEqual(["contracts", { q: "50% & lease" }]);
    expect(
      workspaceListOptions("contracts", "/contracts?standalone=true").queryKey,
    ).toEqual(["contracts"]);
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      await observer.fetchNextPage();
      expect(get.mock.calls.map(([url]) => url)).toEqual([
        "/contracts?standalone=true&q=50%25%20%26%20lease&limit=50&offset=0",
        "/contracts?standalone=true&q=50%25%20%26%20lease&limit=50&offset=50",
      ]);
      expect(observer.getCurrentResult().hasNextPage).toBe(false);
      // Uploads and deletions invalidate the ["contracts"] prefix, which must reach searches.
      await client.invalidateQueries({ queryKey: ["contracts"] });
      expect(get).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
