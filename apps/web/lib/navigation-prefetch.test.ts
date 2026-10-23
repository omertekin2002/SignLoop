import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { apiClient, ApiRequestError, shouldRetryQuery } from "./api-client";
import { createNavigationPrefetcher, prefetchNavigationDestination } from "./navigation-prefetch";
import { chatThreadOptions, contractDetailOptions, projectDetailOptions } from "./workspace-query-options";
import { workspaceListOptions } from "./use-workspace-list";

const clients: QueryClient[] = [];
function createClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: shouldRetryQuery, retryDelay: 0 } },
  });
  clients.push(client);
  return client;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("navigation cache handoff", () => {
  it("reuses a full contract detail on mount and still honors invalidation and freshness expiry", async () => {
    const client = createClient();
    const detail = { title: "Agreement", analyses: [{ id: "analysis", resultJson: { key_points: ["A finding"] } }] };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: detail });
    await prefetchNavigationDestination(client, { kind: "contract", id: "contract" });
    const observer = new QueryObserver(client, contractDetailOptions("contract"));
    const unsubscribe = observer.subscribe(() => {});
    expect(observer.getCurrentResult().data).toEqual(detail);
    expect(get).toHaveBeenCalledOnce();
    unsubscribe();

    await client.invalidateQueries({ queryKey: ["contract", "contract"] });
    await prefetchNavigationDestination(client, { kind: "contract", id: "contract" });
    expect(get).toHaveBeenCalledTimes(2);
    client.setQueryData(["contract", "contract"], detail, { updatedAt: Date.now() - 60_001 });
    await prefetchNavigationDestination(client, { kind: "contract", id: "contract" });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("shares the in-flight recent-history request with navigation, including its HTTP status errors", async () => {
    const client = createClient();
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const prefetch = prefetchNavigationDestination(client, { kind: "thread", id: "thread" });
    const observer = new QueryObserver(client, chatThreadOptions("thread"));
    const unsubscribe = observer.subscribe(() => {});
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chat/threads/thread");
    expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    response.resolve(Response.json({ error: "No access" }, { status: 403 }));
    await prefetch;
    expect(observer.getCurrentResult().error).toMatchObject({ status: 403, message: "No access" });
    expect(observer.getCurrentResult().error).toBeInstanceOf(ApiRequestError);
    expect(shouldRetryQuery(0, observer.getCurrentResult().error)).toBe(false);
    expect(chatThreadOptions("thread").refetchOnWindowFocus).toBe(false);
    unsubscribe();
  });

  it("keeps failed speculation silent and lets the destination use its normal retry policy", async () => {
    const client = createClient();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Offline during hover"))
      .mockRejectedValueOnce(new TypeError("Still reconnecting"))
      .mockResolvedValueOnce(Response.json({ data: { id: "thread", messages: [], hasMore: false } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(prefetchNavigationDestination(client, { kind: "thread", id: "thread" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const observer = new QueryObserver(client, chatThreadOptions("thread"));
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("matches project offsets exactly and never merges another pagination state into the initial view", async () => {
    const client = createClient();
    const get = vi.spyOn(apiClient, "get").mockImplementation(async (url) => ({ data: { title: String(url) } }));
    const next = await client.fetchQuery(projectDetailOptions("project", 50, 20));
    await prefetchNavigationDestination(client, { kind: "project", id: "project" });
    const observer = new QueryObserver(client, projectDetailOptions("project", 0, 0));
    const unsubscribe = observer.subscribe(() => {});
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      "/projects/project?contractsOffset=50&contextOffset=20",
      "/projects/project?contractsOffset=0&contextOffset=0",
    ]);
    expect(observer.getCurrentResult().data?.title).toBe("/projects/project?contractsOffset=0&contextOffset=0");
    expect(client.getQueryData(["project", "project", 50, 20])).toEqual(next);
    expect(client.getQueryData(["project", "project"])).toBeUndefined();
    unsubscribe();
  });

  it.each([
    ["contracts", "contracts", "/contracts?standalone=true&limit=50&offset=0"],
    ["projects", "projects", "/projects?limit=50&offset=0"],
    ["chat", "chat-threads", "/chat/threads?limit=50&offset=0"],
  ] as const)("prefetches just the first %s list page and hands pagination to the destination", async (list, key, path) => {
    const client = createClient();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({
      data: { data: [{ id: "first" }], total: 500, offset: 0, limit: 50 },
    });
    await prefetchNavigationDestination(client, { kind: "list", list });
    const basePath = path.split("&limit")[0]!.split("?limit")[0]!;
    const observer = new InfiniteQueryObserver(client, workspaceListOptions(key, basePath));
    const unsubscribe = observer.subscribe(() => {});
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]?.[0]).toBe(path);
    expect(observer.getCurrentResult().data?.pageParams).toEqual([0]);
    await observer.fetchNextPage();
    expect(get.mock.calls[1]?.[0]).toBe(path.replace("offset=0", "offset=50"));
    unsubscribe();
  });

  it("leaves stale multi-page lists intact instead of collapsing or refreshing them on hover", async () => {
    const client = createClient();
    const pages = { pages: [{ data: [1] }, { data: [2] }], pageParams: [0, 50] };
    client.setQueryData(["projects"], pages, { updatedAt: Date.now() - 60_001 });
    const get = vi.spyOn(apiClient, "get");
    await prefetchNavigationDestination(client, { kind: "list", list: "projects" });
    expect(get).not.toHaveBeenCalled();
    expect(client.getQueryData(["projects"])).toBe(pages);
  });

  it("forwards query cancellation to both Axios details and fetch-based history", async () => {
    const client = createClient();
    let detailSignal: AbortSignal | undefined;
    vi.spyOn(apiClient, "get").mockImplementation((_url, config) => {
      detailSignal = config?.signal as AbortSignal;
      return new Promise(() => {});
    });
    let threadSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, config) => {
      threadSignal = config.signal;
      return new Promise(() => {});
    }));
    const contract = prefetchNavigationDestination(client, { kind: "contract", id: "contract" });
    const thread = prefetchNavigationDestination(client, { kind: "thread", id: "thread" });
    await client.cancelQueries();
    await Promise.all([contract, thread]);
    expect(detailSignal?.aborted).toBe(true);
    expect(threadSignal?.aborted).toBe(true);
    expect(client.getQueryData(["contract", "contract"])).toBeUndefined();
  });

  it("does not replace an active destination read or its retry policy", async () => {
    const client = createClient();
    const response = deferred<Awaited<ReturnType<typeof apiClient.get>>>();
    const get = vi.spyOn(apiClient, "get").mockReturnValue(response.promise);
    const observer = new QueryObserver(client, contractDetailOptions("contract"));
    const unsubscribe = observer.subscribe(() => {});
    await prefetchNavigationDestination(client, { kind: "contract", id: "contract" });
    expect(get).toHaveBeenCalledOnce();
    expect(client.getQueryCache().find({ queryKey: ["contract", "contract"] })?.options.retry).toBe(shouldRetryQuery);
    response.resolve({ data: { title: "Contract" } });
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    unsubscribe();
  });
});

describe("bounded navigation intent", () => {
  it("ignores rapid pass-throughs and coalesces hover/focus without extending the dwell", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: {} });
    const intent = createNavigationPrefetcher(client);
    const first = { kind: "contract", id: "first" } as const;
    const next = { kind: "contract", id: "next" } as const;
    intent.intent(first, "pointer");
    await vi.advanceTimersByTimeAsync(80);
    intent.cancel(first, "pointer");
    intent.intent(next, "pointer");
    await vi.advanceTimersByTimeAsync(80);
    intent.intent(next, "focus");
    intent.cancel(next, "pointer");
    await vi.advanceTimersByTimeAsync(40);
    expect(get.mock.calls.map(([url]) => url)).toEqual(["/contracts/next"]);
    intent.intent(next, "focus");
    await vi.advanceTimersByTimeAsync(120);
    expect(get).toHaveBeenCalledOnce();
    intent.dispose();
  });

  it("caps work at two reads plus the latest still-intended destination", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const responses = [deferred<{ data: object }>(), deferred<{ data: object }>(), deferred<{ data: object }>()];
    const get = vi.spyOn(apiClient, "get").mockImplementation(() => responses[get.mock.calls.length - 1]!.promise);
    const intent = createNavigationPrefetcher(client);
    for (const id of ["a", "b", "discarded", "latest"]) {
      intent.intent({ kind: "contract", id }, "pointer");
      await vi.advanceTimersByTimeAsync(120);
    }
    expect(get).toHaveBeenCalledTimes(2);
    responses[0]!.resolve({ data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(get.mock.calls.map(([url]) => url)).toEqual(["/contracts/a", "/contracts/b", "/contracts/latest"]);
    responses[1]!.resolve({ data: {} });
    responses[2]!.resolve({ data: {} });
    intent.dispose();
  });

  it("cancels a waiting candidate on blur and pending timers on unmount", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const response = deferred<{ data: object }>();
    const get = vi.spyOn(apiClient, "get").mockReturnValue(response.promise);
    const intent = createNavigationPrefetcher(client);
    for (const id of ["a", "b", "waiting"]) {
      intent.intent({ kind: "contract", id }, "focus");
      await vi.advanceTimersByTimeAsync(120);
    }
    intent.cancel({ kind: "contract", id: "waiting" }, "focus");
    response.resolve({ data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(2);
    intent.intent({ kind: "contract", id: "unmounted" }, "focus");
    intent.dispose();
    await vi.advanceTimersByTimeAsync(120);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("lets navigation finish an in-flight read after unmount without duplicating it", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const response = deferred<{ data: object }>();
    const get = vi.spyOn(apiClient, "get").mockReturnValue(response.promise);
    const intent = createNavigationPrefetcher(client);
    intent.intent({ kind: "contract", id: "contract" }, "pointer");
    await vi.advanceTimersByTimeAsync(120);
    intent.dispose();
    const navigation = client.fetchQuery(contractDetailOptions("contract"));
    response.resolve({ data: { title: "Contract" } });
    expect(await navigation).toEqual({ title: "Contract" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("drops retired-account intent and never transfers its cache to the next client", async () => {
    vi.useFakeTimers();
    const oldClient = createClient();
    const nextClient = createClient();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: { title: "Owner A" } });
    await prefetchNavigationDestination(oldClient, { kind: "contract", id: "shared-id" });
    const oldIntent = createNavigationPrefetcher(oldClient);
    oldIntent.intent({ kind: "project", id: "pending-owner-a" }, "focus");
    oldIntent.dispose();
    await oldClient.cancelQueries();
    oldClient.clear();
    await vi.advanceTimersByTimeAsync(120);
    expect(get).toHaveBeenCalledOnce();
    expect(nextClient.getQueryData(["contract", "shared-id"])).toBeUndefined();
    get.mockResolvedValueOnce({ data: { title: "Owner B" } });
    await prefetchNavigationDestination(nextClient, { kind: "contract", id: "shared-id" });
    expect(nextClient.getQueryData(["contract", "shared-id"])).toEqual({ title: "Owner B" });
    expect(oldClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
