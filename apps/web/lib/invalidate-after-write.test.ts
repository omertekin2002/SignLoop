import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { apiClient } from "./api-client";
import { invalidateAfterWrite } from "./invalidate-after-write";
import { prefetchNavigationDestination } from "./navigation-prefetch";
import { workspaceListOptions } from "./use-workspace-list";
import {
  contractDetailOptions,
  projectDetailOptions,
} from "./workspace-query-options";

const clients: QueryClient[] = [];
function createClient() {
  // The app's freshness window: an answer stored as fresh is not requested again for a minute.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  clients.push(client);
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const page = (...ids: string[]) => ({
  data: {
    data: ids.map((id) => ({ id })),
    offset: 0,
    limit: 50,
    total: ids.length,
  },
});

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

describe("invalidating after a write", () => {
  it("restarts a search still waiting for its first response, instead of keeping that earlier answer", async () => {
    const client = createClient();
    // The first search is sent before a chat is deleted and answered late, still listing it.
    const earlier = deferred<ReturnType<typeof page>>();
    const signals: Array<AbortSignal | undefined> = [];
    vi.spyOn(apiClient, "get").mockImplementation(async (_url, config) => {
      signals.push(config?.signal as AbortSignal | undefined);
      return signals.length === 1 ? earlier.promise : page("kept-thread");
    });
    const observer = new InfiniteQueryObserver(
      client,
      workspaceListOptions<{ id: string }>(
        "chat-threads",
        "/chat/threads",
        "thread",
      ),
    );
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(observer.getCurrentResult().isPending).toBe(true);

      const invalidated = invalidateAfterWrite(client, ["chat-threads"]);
      earlier.resolve(page("deleted-thread", "kept-thread"));
      await invalidated;

      const result = observer.getCurrentResult();
      expect(result.data?.pages[0]?.data).toEqual([{ id: "kept-thread" }]);
      expect(result.isStale).toBe(false);
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("drops a hover prefetch sent before the write, so the page it was for reads again", async () => {
    const client = createClient();
    const earlier = deferred<{ data: { title: string } }>();
    const get = vi
      .spyOn(apiClient, "get")
      .mockImplementationOnce(() => earlier.promise)
      .mockResolvedValue({ data: { title: "After the write" } });

    // Nothing observes a prefetch, so invalidating alone would neither restart nor discard it.
    const prefetch = prefetchNavigationDestination(client, {
      kind: "contract",
      id: "contract",
    });
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());

    await invalidateAfterWrite(client, ["contract", "contract"]);
    earlier.resolve({ data: { title: "Before the write" } });
    await prefetch;
    expect(client.getQueryData(["contract", "contract"])).toBeUndefined();

    const observer = new QueryObserver(
      client,
      contractDetailOptions("contract"),
    );
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toEqual({
          title: "After the write",
        }),
      );
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("restarts a project page that was still loading, under a key it only prefixes", async () => {
    const client = createClient();
    const earlier = deferred<{ data: { id: string; title: string } }>();
    const get = vi
      .spyOn(apiClient, "get")
      .mockImplementationOnce(() => earlier.promise)
      .mockResolvedValue({ data: { id: "project", title: "After the write" } });
    // The second page of a project's contracts: a new key, so its first request has no data yet.
    const observer = new QueryObserver(
      client,
      projectDetailOptions("project", 50, 0),
    );
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());

      const invalidated = invalidateAfterWrite(
        client,
        ["project", "project"],
        ["projects"],
      );
      earlier.resolve({ data: { id: "project", title: "Before the write" } });
      await invalidated;

      expect(observer.getCurrentResult().data?.title).toBe("After the write");
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("refetches loaded queries on screen, marks the rest stale, and leaves other keys alone", async () => {
    const client = createClient();
    const get = vi
      .spyOn(apiClient, "get")
      .mockImplementation(async () => page("row"));
    const observe = (key: string, urlPath: string, search = "") => {
      const observer = new InfiniteQueryObserver(
        client,
        workspaceListOptions<{ id: string }>(key, urlPath, search),
      );
      return observer.subscribe(() => {});
    };
    const unsubscribes = [
      observe("contracts", "/contracts?standalone=true"),
      observe("contracts", "/contracts?standalone=true", "lease"),
      observe("chat-threads", "/chat/threads"),
    ];
    try {
      await client.prefetchInfiniteQuery(
        workspaceListOptions("projects", "/projects"),
      );
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
      get.mockClear();

      await invalidateAfterWrite(client, ["contracts"], ["projects"]);

      expect(get.mock.calls.map(([url]) => url).sort()).toEqual([
        "/contracts?standalone=true&limit=50&offset=0",
        "/contracts?standalone=true&q=lease&limit=50&offset=0",
      ]);
      expect(client.getQueryState(["projects"])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["chat-threads"])?.isInvalidated).toBe(false);
    } finally {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    }
  });
});

describe("workspace writes", () => {
  // Keys of the lists, searches and detail pages that searches, pagination and hover prefetches
  // can leave waiting for a first response. Settings and usage are single, always-loaded queries.
  const workspaceKeys = [
    "contracts",
    "projects",
    "chat-threads",
    "contract",
    "project",
  ];
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = ["app", "components", "lib"].flatMap((directory) =>
    readdirSync(path.join(root, directory), {
      recursive: true,
      encoding: "utf8",
    })
      .filter(
        (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
      )
      .map((file) => path.join(directory, file)),
  );

  it("never invalidate workspace queries without cancelling their requests first", () => {
    const bare = new RegExp(
      `invalidateQueries\\(\\s*\\{\\s*queryKey:\\s*\\[\\s*"(?:${workspaceKeys.join("|")})"`,
    );
    const offenders = sources.filter((file) =>
      bare.test(readFileSync(path.join(root, file), "utf8")),
    );
    expect(sources.length).toBeGreaterThan(50);
    expect(
      offenders,
      "use invalidateAfterWrite from lib/invalidate-after-write.ts",
    ).toEqual([]);
  });
});
