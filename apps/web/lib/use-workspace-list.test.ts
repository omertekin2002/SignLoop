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
