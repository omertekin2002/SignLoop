import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createOperationGuard } from "./operation-guard";

describe("conversation restore operations", () => {
  it("ignores a late restore after selection changes even when the observer now returns B", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    const a = { id: "A", messages: ["A-saved"] };
    const b = { id: "B", messages: ["B-saved"] };
    client.setQueryData(["thread", "A"], a);
    client.setQueryData(["thread", "B"], b);
    let finish!: (value: typeof a) => void;
    const pending = new Promise<typeof a>((resolve) => { finish = resolve; });
    const observer = new QueryObserver(client, { queryKey: ["thread", "A"], queryFn: () => pending });
    const unsubscribe = observer.subscribe(() => {});
    const guard = createOperationGuard();
    const isCurrent = guard.begin();
    const resetRuntime = vi.fn();
    const restore = observer.refetch().then((result) => {
      if (isCurrent()) resetRuntime(result.data);
      return result.data;
    });
    // The ChatPanel selection effect invalidates the old operation before B can start a run.
    guard.invalidate();
    observer.setOptions({ queryKey: ["thread", "B"], queryFn: async () => b });
    finish(a);
    expect(await restore).toEqual(b);
    expect(resetRuntime).not.toHaveBeenCalled();
    unsubscribe();
    client.clear();
  });

  it("invalidates prior work on mode changes, unmounts and newer restore attempts", () => {
    const guard = createOperationGuard();
    const first = guard.begin();
    expect(first()).toBe(true);
    guard.invalidate();
    expect(first()).toBe(false);
    const second = guard.begin();
    const third = guard.begin();
    expect(second()).toBe(false);
    expect(third()).toBe(true);
    guard.invalidate();
    expect(third()).toBe(false);
  });
});
